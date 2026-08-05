import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  SYSTEM_ACTOR_LABEL,
  lockedObjectMessage,
  StaleVersionError,
  SpecWriteForbiddenError,
} from '../db/index.js';
import { gateErrorResponse } from '../api/edit-gate-response.js';
import { historyActor } from '../test-utils/history-actor.js';
import {
  handleUpdateParagraph,
  handleRemoveParagraph,
  handleInsertParagraph,
  handleAcceptCommentAsNote,
} from './paragraph-handlers.js';
import {
  handleListAssociations,
  handleCreateAssociation,
  handleDeleteAssociation,
} from './association-handlers.js';
import type { ToolResult } from './handlers.js';
import { findAnchoredParagraph } from '../parser/index.js';
import { UUID_TAG_PREFIX } from '../ast/index.js';
import type { ObjectBlobNode, ObjectMeta } from '../ast/index.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
let libraryId: string;
let specId: string;
let otherSpecId: string;
let bodyId: string;
let noteId: string;
let continuationId: string;

// Assert on the VALUE, not mere key presence, so the checks survive a handler that
// ever returns an explicit `isError: false` on success (mirrors the wave-2 helper).
function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}

function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

function textOf(res: ToolResult): string {
  return res.content[0]?.text ?? '';
}

function structuredContentOf(res: ToolResult): unknown {
  return 'structuredContent' in res ? res.structuredContent : undefined;
}

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'ufgs', $3) RETURNING id`,
    [section, title, libraryId]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('failed to insert test spec');
  return id;
}

async function insertParagraph(spec: string, nodeType: string, text: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
     VALUES ($1, NULL, $2, $3, 0, 1) RETURNING id`,
    [spec, nodeType, text]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('failed to insert test paragraph');
  return id;
}

/** An `object` row plus a single `objectText` child anchored inside its
 * captured blob (#519, ADR-072 decision 3) — the minimal fixture the
 * successful-edit test below needs to exercise the real write path through
 * `handleUpdateParagraph`, not just db/queries directly. */
async function insertAnchoredObjectPair(
  spec: string,
  anchorText: string
): Promise<{ objectId: string; textId: string }> {
  const objectId = await insertParagraph(spec, 'object', '[TABLE]');
  const textRow = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
     VALUES ($1, $2, 'objectText', $3, 0, 1) RETURNING id`,
    [spec, objectId, anchorText]
  );
  const textId = textRow.rows[0]?.id;
  if (!textId) throw new Error('failed to insert test objectText row');

  const meta: ObjectMeta = {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: 1,
    blob: [
      {
        'w:sdt': [
          { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${textId}` } }] },
          { 'w:sdtContent': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': anchorText }] }] }] }] },
        ],
      } as ObjectBlobNode,
    ],
  };
  await pool.query(`UPDATE paragraphs SET object_data = $2::jsonb WHERE id = $1`, [
    objectId,
    JSON.stringify(meta),
  ]);

  return { objectId, textId };
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries ORDER BY created_at LIMIT 1`
  );
  const id = lib.rows[0]?.id;
  if (!id) throw new Error('no library seeded — run pnpm seed');
  libraryId = id;
  specId = await insertSpec('27 21 00', 'Structured Cabling');
  otherSpecId = await insertSpec('09 91 26', 'Painting');
  bodyId = await insertParagraph(specId, 'pr1', 'Provide cabling.');
  noteId = await insertParagraph(specId, 'note', 'Editor note.');
  // The other tierless anchor: continues the preceding node's text (#383).
  continuationId = await insertParagraph(specId, 'continuation', '…continued.');
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[specId, otherSpecId]]);
});

describe('update_paragraph MCP tool', () => {
  it('replaces text in place and returns the node keyed as the REST sibling (data.id/text)', async () => {
    const res = await handleUpdateParagraph({
      specId,
      nodeId: bodyId,
      text: 'Provide Cat 6A cabling.',
    });
    expect(isToolError(res)).toBe(false);
    const node = parse<{ id: string; text: string }>(res);
    expect(node.id).toBe(bodyId);
    expect(node.text).toBe('Provide Cat 6A cabling.');
  });

  it('rejects a node that belongs to a different spec', async () => {
    const res = await handleUpdateParagraph({ specId: otherSpecId, nodeId: bodyId, text: 'x' });
    expect(isToolError(res)).toBe(true);
  });

  it('rejects a missing node and an empty text', async () => {
    expect(isToolError(await handleUpdateParagraph({ specId, nodeId: MISSING, text: 'x' }))).toBe(
      true
    );
    expect(isToolError(await handleUpdateParagraph({ specId, nodeId: bodyId, text: '' }))).toBe(
      true
    );
  });

  it('maps a stale expectedVersion to a tool error (ADR-018 optimistic concurrency)', async () => {
    const v = await pool.query<{ content_version: number }>(
      'SELECT content_version FROM specs WHERE id = $1',
      [specId]
    );
    const current = v.rows[0]?.content_version ?? 1;
    const res = await handleUpdateParagraph({
      specId,
      nodeId: bodyId,
      text: 'stale write',
      expectedVersion: current + 100, // mismatch → StaleVersionError → tool error
    });
    expect(isToolError(res)).toBe(true);
    // #583/ADR-085: carries REST's one actionable supplemental field
    // so an agent can re-read the current version instead of regexing prose.
    expect(structuredContentOf(res)).toEqual({ currentVersion: current });
    // Full prose too, including the trailing guidance clause (paragraph-handlers.ts:30) —
    // structuredContent alone leaves that clause unpinned at the integration boundary.
    expect(textOf(res)).toBe(
      `stale version — current contentVersion is ${current}; refetch and retry`
    );
    // Cross-check against the actual REST gateErrorResponse (src/api/edit-gate-
    // response.ts) for an equivalent error over this same live currentVersion —
    // pins the parity claim against the real function, not a hardcoded literal.
    const rest = gateErrorResponse(new StaleVersionError('stale write', current));
    expect(rest?.status).toBe(409);
    expect(structuredContentOf(res)).toEqual({ currentVersion: rest?.body.currentVersion });
  });

  it('an archived spec is a write-forbidden tool error with no structuredContent (#583/ADR-085)', async () => {
    const archivedSpecId = await insertSpec('26 05 00', 'Archived Fixture');
    const archivedBodyId = await insertParagraph(archivedSpecId, 'pr1', 'Provide conduit.');
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [
      archivedSpecId,
    ]);
    try {
      const res = await handleUpdateParagraph({
        specId: archivedSpecId,
        nodeId: archivedBodyId,
        text: 'attempted edit',
      });
      expect(isToolError(res)).toBe(true);
      expect(textOf(res)).toBe('spec is archived and cannot be edited');
      expect(structuredContentOf(res)).toBeUndefined();
      expect('structuredContent' in res).toBe(false);
      // Cross-check against the actual REST gateErrorResponse: confirm its 409
      // body for this class genuinely carries nothing beyond `error`.
      const rest = gateErrorResponse(
        new SpecWriteForbiddenError('spec is archived and cannot be edited')
      );
      expect(rest?.status).toBe(409);
      expect(Object.keys(rest?.body ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
        'error',
        'success',
      ]);
    } finally {
      await pool.query('DELETE FROM specs WHERE id = $1', [archivedSpecId]);
    }
  });

  it('rejects a direct write to a locked object row, mirroring the REST 422 (#519, ADR-072 decision 3)', async () => {
    const objectId = await insertParagraph(specId, 'object', '[TABLE]');
    const res = await handleUpdateParagraph({
      specId,
      nodeId: objectId,
      text: 'attempted direct rewrite',
    });
    expect(isToolError(res)).toBe(true);
    // Exact equality (not a substring match) against the shared helper (#519 review
    // finding) — this is the same string the REST test above pins, so the two
    // surfaces are provably identical, not just each individually containing
    // "locked"/"objectText".
    expect(res.content[0]!.text).toBe(lockedObjectMessage('object'));
  });

  // #519 review finding: the locked-object guard's OTHER half — an objectText
  // child is ALWAYS editable — had no MCP-layer (or REST-layer) coverage of an
  // actual successful edit; only a lower-level db/queries.updateParagraphText
  // unit exercised it. This drives the real tool handler end-to-end.
  it('a successful objectText edit rewrites the parent object blob, mirroring the REST wire path (#519)', async () => {
    const { objectId, textId } = await insertAnchoredObjectPair(specId, 'Original interior text.');

    const res = await handleUpdateParagraph({
      specId,
      nodeId: textId,
      text: 'Rewritten interior text.',
    });
    expect(isToolError(res)).toBe(false);
    const node = parse<{ id: string; type: string; text: string }>(res);
    expect(node.id).toBe(textId);
    expect(node.type).toBe('objectText');
    expect(node.text).toBe('Rewritten interior text.');

    const objectRow = await pool.query<{ object_data: ObjectMeta }>(
      'SELECT object_data FROM paragraphs WHERE id = $1',
      [objectId]
    );
    expect(findAnchoredParagraph(objectRow.rows[0]!.object_data.blob, textId)).toEqual({
      'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': 'Rewritten interior text.' }] }] }],
    });
  });
});

describe('update_paragraph MCP tool — actorLabel attribution (#377)', () => {
  it('a supplied actorLabel attributes the history row', async () => {
    const target = await insertParagraph(specId, 'pr1', 'Attribution target.');
    const res = await handleUpdateParagraph({
      specId,
      nodeId: target,
      text: 'Updated with attribution.',
      actorLabel: 'mcp.bot',
    });
    expect(isToolError(res)).toBe(false);
    expect(await historyActor(pool, target, 2)).toBe('mcp.bot'); // base_version 1 → 2
  });

  it('omitting actorLabel attributes the history row to the SYSTEM_ACTOR_LABEL sentinel — byte-identical to the pre-#377 path', async () => {
    const target = await insertParagraph(specId, 'pr1', 'Attribution target 2.');
    const res = await handleUpdateParagraph({ specId, nodeId: target, text: 'Updated, no actor.' });
    expect(isToolError(res)).toBe(false);
    expect(await historyActor(pool, target, 2)).toBe(SYSTEM_ACTOR_LABEL);
  });
});

describe('insert_paragraph MCP tool', () => {
  it('inserts a sibling after the anchor and returns the created SpecNode', async () => {
    const res = await handleInsertParagraph({
      specId,
      anchorNodeId: bodyId,
      text: 'Inserted via MCP.',
    });
    expect(isToolError(res)).toBe(false);
    const node = parse<{ id: string; type: string; text: string }>(res);
    expect(node.type).toBe('pr1'); // defaulted to the anchor's type
    expect(node.text).toBe('Inserted via MCP.');
    const row = await pool.query<{ position: number }>(
      'SELECT position FROM paragraphs WHERE id = $1',
      [node.id]
    );
    expect(row.rows[0]?.position).toBeGreaterThan(0);
  });

  it('rejects an anchor from a different spec and a missing anchor', async () => {
    expect(
      isToolError(
        await handleInsertParagraph({ specId: otherSpecId, anchorNodeId: bodyId, text: 'x' })
      )
    ).toBe(true);
    expect(
      isToolError(await handleInsertParagraph({ specId, anchorNodeId: MISSING, text: 'x' }))
    ).toBe(true);
  });

  it('refuses the defaulted type for a note anchor unless nodeType is explicit', async () => {
    const defaulted = await handleInsertParagraph({ specId, anchorNodeId: noteId, text: 'x' });
    expect(isToolError(defaulted)).toBe(true);
    const explicit = await handleInsertParagraph({
      specId,
      anchorNodeId: noteId,
      text: 'Explicit pr1 after a note.',
      nodeType: 'pr1',
    });
    expect(isToolError(explicit)).toBe(false);
  });

  it('rejects an explicit nodeType that is a legal insertable type in general but not a legal sibling of THIS anchor (#383)', async () => {
    // pr2 is never a sibling of pr1 — pr2 nests as a pr1's CHILD, so an
    // explicit pr2 requested after a pr1 anchor is structurally incompatible
    // even though pr2 is on the insertable list.
    const res = await handleInsertParagraph({
      specId,
      anchorNodeId: bodyId,
      text: 'Should not become a mis-tiered pr2.',
      nodeType: 'pr2',
    });
    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toContain('"pr2"');
  });

  it('accepts any insertable explicit type after a note anchor — KNOWN AMBIGUITY: a note has no tier to mismatch against (#383)', async () => {
    // KNOWN AMBIGUITY (#383): a note carries no CSI tier of its own, so it
    // cannot constrain what tier follows it — any already-insertable type
    // (not just the pr1 the earlier test above pins) is deliberately accepted.
    const res = await handleInsertParagraph({
      specId,
      anchorNodeId: noteId,
      text: 'Explicit article after a note.',
      nodeType: 'article',
    });
    expect(isToolError(res)).toBe(false);
  });

  it('accepts an explicit pr1 after a continuation anchor — KNOWN AMBIGUITY: a continuation inherits its tier rather than stating one (#383)', async () => {
    // KNOWN AMBIGUITY (#383): the second tierless anchor type. A continuation
    // continues the preceding node's text, so it has no tier of its own for an
    // explicit nodeType to mismatch against — this previously errored.
    const res = await handleInsertParagraph({
      specId,
      anchorNodeId: continuationId,
      text: 'A pr1 after a continuation.',
      nodeType: 'pr1',
    });
    expect(isToolError(res)).toBe(false);
  });
});

describe('insert_paragraph MCP tool — actorLabel attribution (#377)', () => {
  it('a supplied actorLabel attributes the insert history row', async () => {
    const res = await handleInsertParagraph({
      specId,
      anchorNodeId: bodyId,
      text: 'Inserted with attribution.',
      actorLabel: 'mcp.bot',
    });
    expect(isToolError(res)).toBe(false);
    const node = parse<{ id: string }>(res);
    expect(await historyActor(pool, node.id, 1)).toBe('mcp.bot');
  });

  it('omitting actorLabel attributes the insert history row to the SYSTEM_ACTOR_LABEL sentinel', async () => {
    const res = await handleInsertParagraph({
      specId,
      anchorNodeId: bodyId,
      text: 'Inserted, no actor.',
    });
    expect(isToolError(res)).toBe(false);
    const node = parse<{ id: string }>(res);
    expect(await historyActor(pool, node.id, 1)).toBe(SYSTEM_ACTOR_LABEL);
  });
});

describe('remove_paragraph MCP tool', () => {
  it('soft-removes then restores a body paragraph (reversible vanish)', async () => {
    const removed = await handleRemoveParagraph({ specId, nodeId: bodyId, removed: true });
    expect(isToolError(removed)).toBe(false);
    const after = await pool.query<{ vanish: boolean }>(
      `SELECT vanish FROM paragraphs WHERE id = $1`,
      [bodyId]
    );
    expect(after.rows[0]?.vanish).toBe(true);

    const restored = await handleRemoveParagraph({ specId, nodeId: bodyId, removed: false });
    expect(isToolError(restored)).toBe(false);
  });

  it('rejects removing a note node — not render-suppressible (422 in REST)', async () => {
    const res = await handleRemoveParagraph({ specId, nodeId: noteId, removed: true });
    expect(isToolError(res)).toBe(true);
  });
});

describe('remove_paragraph MCP tool — actorLabel attribution (#377)', () => {
  it('a supplied actorLabel attributes the remove history row', async () => {
    const target = await insertParagraph(specId, 'pr1', 'Removable.');
    const res = await handleRemoveParagraph({
      specId,
      nodeId: target,
      removed: true,
      actorLabel: 'mcp.bot',
    });
    expect(isToolError(res)).toBe(false);
    expect(await historyActor(pool, target, 2)).toBe('mcp.bot'); // previousBaseVersion 1 → 2
  });

  it('omitting actorLabel attributes the remove history row to the SYSTEM_ACTOR_LABEL sentinel', async () => {
    const target = await insertParagraph(specId, 'pr1', 'Removable 2.');
    const res = await handleRemoveParagraph({ specId, nodeId: target, removed: true });
    expect(isToolError(res)).toBe(false);
    expect(await historyActor(pool, target, 2)).toBe(SYSTEM_ACTOR_LABEL);
  });
});

describe('paragraph association MCP tools', () => {
  it('create → list → delete round-trip, scoped to the owning spec', async () => {
    const created = await handleCreateAssociation({
      specId,
      nodeId: bodyId,
      label: 'Cat 6A datasheet',
      url: 'https://example.com/datasheet.pdf',
    });
    expect(isToolError(created)).toBe(false);
    const assoc = parse<{ id: string; label: string; url: string }>(created);
    expect(assoc.label).toBe('Cat 6A datasheet');

    const listed = await handleListAssociations({ specId, nodeId: bodyId });
    expect(isToolError(listed)).toBe(false);
    const rows = parse<{ id: string }[]>(listed);
    expect(rows.some((r) => r.id === assoc.id)).toBe(true);

    const deleted = await handleDeleteAssociation({
      specId,
      nodeId: bodyId,
      associationId: assoc.id,
    });
    expect(isToolError(deleted)).toBe(false);
    expect(parse<{ deleted: boolean }>(deleted).deleted).toBe(true);

    // second delete is a not-found tool error (idempotent-safe surface)
    expect(
      isToolError(
        await handleDeleteAssociation({ specId, nodeId: bodyId, associationId: assoc.id })
      )
    ).toBe(true);
  });

  it('rejects a create with neither a url nor a complete DMS pair (cross-field rule)', async () => {
    const res = await handleCreateAssociation({ specId, nodeId: bodyId, label: 'no link' });
    expect(isToolError(res)).toBe(true);
  });

  it('rejects an association call whose node belongs to a different spec', async () => {
    const res = await handleListAssociations({ specId: otherSpecId, nodeId: bodyId });
    expect(isToolError(res)).toBe(true);
  });
});

describe('accept_comment_as_note MCP tool', () => {
  it('returns a tool error when the anchor has no comment at the index', async () => {
    const res = await handleAcceptCommentAsNote({ specId, nodeId: bodyId, index: 0 });
    expect(isToolError(res)).toBe(true);
  });

  it('rejects a missing anchor and a wrong-spec anchor', async () => {
    expect(
      isToolError(await handleAcceptCommentAsNote({ specId, nodeId: MISSING, index: 0 }))
    ).toBe(true);
    expect(
      isToolError(
        await handleAcceptCommentAsNote({ specId: otherSpecId, nodeId: bodyId, index: 0 })
      )
    ).toBe(true);
  });

  it('materializes a comment as a note and is idempotent (returns { noteId } both times)', async () => {
    const anchor = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version, source_facts)
       VALUES ($1, NULL, 'pr1', 'Anchor.', 5, 1, $2::jsonb) RETURNING id`,
      [
        specId,
        JSON.stringify({
          comments: [
            { author: 'Reviewer', text: 'Add UL listing.', anchor: [0, 5], closed: false },
          ],
        }),
      ]
    );
    const anchorId = anchor.rows[0]!.id;

    // Accept via an UPPERCASE specId: ownership must pass (case-normalized), and the
    // new note row must persist the canonical lowercase spec_id (CodeRabbit — finding 1).
    const upper = specId.toUpperCase();
    const first = await handleAcceptCommentAsNote({ specId: upper, nodeId: anchorId, index: 0 });
    expect(isToolError(first)).toBe(false);
    const noteId = parse<{ noteId: string }>(first).noteId;
    expect(noteId).toBeTruthy();

    const noteRow = await pool.query<{ spec_id: string }>(
      'SELECT spec_id FROM paragraphs WHERE id = $1',
      [noteId]
    );
    expect(noteRow.rows[0]?.spec_id).toBe(specId); // canonical lowercase, not the uppercase input

    // Idempotent repeat: same noteId, no duplicate, still a success (not REST's 409).
    const second = await handleAcceptCommentAsNote({ specId: upper, nodeId: anchorId, index: 0 });
    expect(isToolError(second)).toBe(false);
    expect(parse<{ noteId: string }>(second).noteId).toBe(noteId);
  });

  it('normalizes specId case — an uppercase but correct specId is not a false wrong-spec', async () => {
    // Regression (Codex P3): acceptCommentAsNote compared spec_id case-sensitively, so a
    // valid uppercase specId false-failed as wrong-spec. It must reach the no-comment path.
    const res = await handleAcceptCommentAsNote({
      specId: specId.toUpperCase(),
      nodeId: bodyId,
      index: 0,
    });
    expect(isToolError(res)).toBe(true); // bodyId has no comment at index 0…
    expect(res.content[0]!.text).toContain('no comment'); // …but ownership passed despite the case
  });
});

describe('accept_comment_as_note MCP tool — actorLabel attribution (#377)', () => {
  async function anchorWithComment(): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version, source_facts)
       VALUES ($1, NULL, 'pr1', 'Anchor.', 11, 1, $2::jsonb) RETURNING id`,
      [specId, JSON.stringify({ comments: [{ author: 'A', text: 'x', anchor: [0, 1] }] })]
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error('failed to insert comment anchor');
    return id;
  }

  it('a supplied actorLabel attributes the note history row', async () => {
    const anchor = await anchorWithComment();
    const res = await handleAcceptCommentAsNote({
      specId,
      nodeId: anchor,
      index: 0,
      actorLabel: 'mcp.bot',
    });
    expect(isToolError(res)).toBe(false);
    const noteId = parse<{ noteId: string }>(res).noteId;
    expect(await historyActor(pool, noteId, 1)).toBe('mcp.bot');
  });

  it('omitting actorLabel attributes the note history row to the SYSTEM_ACTOR_LABEL sentinel', async () => {
    const anchor = await anchorWithComment();
    const res = await handleAcceptCommentAsNote({ specId, nodeId: anchor, index: 0 });
    expect(isToolError(res)).toBe(false);
    const noteId = parse<{ noteId: string }>(res).noteId;
    expect(await historyActor(pool, noteId, 1)).toBe(SYSTEM_ACTOR_LABEL);
  });
});
