import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import {
  handleUpdateParagraph,
  handleRemoveParagraph,
  handleAcceptCommentAsNote,
} from './paragraph-handlers.js';
import {
  handleListAssociations,
  handleCreateAssociation,
  handleDeleteAssociation,
} from './association-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
let libraryId: string;
let specId: string;
let otherSpecId: string;
let bodyId: string;
let noteId: string;

// Assert on the VALUE, not mere key presence, so the checks survive a handler that
// ever returns an explicit `isError: false` on success (mirrors the wave-2 helper).
function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}

function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
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

    const first = await handleAcceptCommentAsNote({ specId, nodeId: anchorId, index: 0 });
    expect(isToolError(first)).toBe(false);
    const noteId = parse<{ noteId: string }>(first).noteId;
    expect(noteId).toBeTruthy();

    // Idempotent repeat: same noteId, no duplicate, still a success (not REST's 409).
    const second = await handleAcceptCommentAsNote({ specId, nodeId: anchorId, index: 0 });
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
