import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { ConventionValidationError } from './conventions.js';
import { SpecWriteForbiddenError } from './edit-gate.js';
import {
  setSpecEditabilityOverride,
  clearSpecEditabilityOverride,
  reclassifySpec,
  acceptCommentAsNote,
} from './reclassify.js';

let specId: string;
let otherSpecId: string;
let nodeId: string;
let libraryId: string;

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master'`
  );
  libraryId = lib.rows[0]!.id;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ('00 00 01', 'recl-it', 'arcat', $1) RETURNING id`,
    [libraryId]
  );
  specId = s.rows[0]!.id;
  const o = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ('00 00 02', 'recl-it-other', 'arcat', $1) RETURNING id`,
    [libraryId]
  );
  otherSpecId = o.rows[0]!.id;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'pr1', 'A para', 1) RETURNING id`,
    [specId]
  );
  nodeId = p.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [[specId, otherSpecId]]);
});

describe('setSpecEditabilityOverride', () => {
  it('sets the override on a paragraph that belongs to the spec', async () => {
    const r = await setSpecEditabilityOverride(specId, nodeId, 'note');
    expect(r.status).toBe('ok');
    const row = await pool.query<{ editability_override: { editability: string } | null }>(
      `SELECT editability_override FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(row.rows[0]!.editability_override).toEqual({ editability: 'note' });
  });

  it('returns wrong-spec when the node belongs to another spec', async () => {
    const r = await setSpecEditabilityOverride(otherSpecId, nodeId, 'editable');
    expect(r.status).toBe('wrong-spec');
  });

  it('returns not-found for an unknown node', async () => {
    const r = await setSpecEditabilityOverride(
      specId,
      '00000000-0000-0000-0000-000000000000',
      'editable'
    );
    expect(r.status).toBe('not-found');
  });
});

describe('clearSpecEditabilityOverride', () => {
  it('clears the override (effective value falls back to machine)', async () => {
    await setSpecEditabilityOverride(specId, nodeId, 'note');
    const r = await clearSpecEditabilityOverride(specId, nodeId);
    expect(r.status).toBe('ok');
    const row = await pool.query<{ editability_override: unknown }>(
      `SELECT editability_override FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(row.rows[0]!.editability_override).toBeNull();
  });
});

describe('reclassifySpec', () => {
  it('classifies stored facts from a banner — no source document', async () => {
    // paragraph whose source_facts carry a captured banner fact → note
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'NOTES TO SPECIFIER', 1, $2::jsonb) RETURNING id`,
      [specId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const bannerNode = p.rows[0]!.id;
    const out = await reclassifySpec(specId, { rules: {} });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') throw new Error('expected ok');
    const entry = out.report.entries.find((e) => e.nodeId === bannerNode);
    expect(entry?.after).toBe('note');
    // persisted: a fresh read shows the stored classification
    const row = await pool.query<{ classification: { editability: string } }>(
      `SELECT classification FROM paragraphs WHERE id = $1`,
      [bannerNode]
    );
    expect(row.rows[0]!.classification.editability).toBe('note');
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [bannerNode]);
  });

  it('preview does not persist', async () => {
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Preview para', 1, $2::jsonb) RETURNING id`,
      [specId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const previewNode = p.rows[0]!.id;
    const out = await reclassifySpec(specId, { rules: {}, preview: true });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') throw new Error('expected ok');
    expect(out.report.persisted).toBe(false);
    const row = await pool.query<{ classification: unknown }>(
      `SELECT classification FROM paragraphs WHERE id = $1`,
      [previewNode]
    );
    expect(row.rows[0]!.classification).toBeNull();
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [previewNode]);
  });

  it('returns not-found for an unknown spec', async () => {
    const out = await reclassifySpec('00000000-0000-0000-0000-000000000000', { rules: {} });
    expect(out.status).toBe('not-found');
  });

  it('bodyless reclassify on a project copy (library_id NULL) uses the built-in default', async () => {
    // A project working copy owns by project_id, not library_id (owner-XOR).
    // With no request rules and no library convention, reclassify must fall back
    // to the built-in Industry Default — not return no-convention.
    // Clear any leftover from a prior failed run (specs.project_id is not
    // ON DELETE CASCADE, so a failed cleanup can orphan the copy + project).
    await pool.query(`DELETE FROM specs WHERE title = 'project copy' AND section = '00 00 08'`);
    await pool.query(`DELETE FROM projects WHERE name = 'recl-builtin-fallback'`);
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('recl-builtin-fallback') RETURNING id`
    );
    const projectId = proj.rows[0]!.id;
    const copy = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, project_id) VALUES ('00 00 08', 'project copy', 'arcat', $1) RETURNING id`,
      [projectId]
    );
    const copyId = copy.rows[0]!.id;
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'NOTES TO SPECIFIER', 1, $2::jsonb) RETURNING id`,
      [copyId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const bannerNode = p.rows[0]!.id;
    const out = await reclassifySpec(copyId, {});
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') throw new Error('expected ok');
    expect(out.report.entries.find((e) => e.nodeId === bannerNode)?.after).toBe('note');
    // specs.project_id is not ON DELETE CASCADE — delete the copy before the project.
    await pool.query(`DELETE FROM specs WHERE id = $1`, [copyId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  it('rejects request-supplied noteBanners with a catastrophic regex before classifying', async () => {
    // A paragraph that classify() would otherwise visit; if the engine ran the
    // unsafe pattern over this text it would backtrack catastrophically.
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position)
       VALUES ($1, 'pr1', ${"'aaaaaaaaaaaaaaaaaaaaaaaaaaX'"}, 1) RETURNING id`,
      [specId]
    );
    const node = p.rows[0]!.id;
    // The same regex-safety guard the convention CRUD path enforces must apply
    // to request-supplied rules — the engine must never see the unsafe pattern.
    await expect(
      reclassifySpec(specId, { rules: { noteBanners: ['(a+)+$'] } })
    ).rejects.toBeInstanceOf(ConventionValidationError);
    // No classification was written — classify() was never reached.
    const row = await pool.query<{ classification: unknown }>(
      `SELECT classification FROM paragraphs WHERE id = $1`,
      [node]
    );
    expect(row.rows[0]!.classification).toBeNull();
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [node]);
  });
});

describe('acceptCommentAsNote', () => {
  it('inserts a note adjacent to the anchor; repeat is 409 (already-accepted)', async () => {
    const anchor = await pool.query<{ id: string; position: number }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Anchor para', 10, $2::jsonb) RETURNING id, position`,
      [
        specId,
        JSON.stringify({ comments: [{ author: 'JDoe', text: 'Verify w/ owner', anchor: [0, 5] }] }),
      ]
    );
    const anchorId = anchor.rows[0]!.id;

    const first = await acceptCommentAsNote(specId, anchorId, 0);
    expect(first.status).toBe('created');
    if (first.status !== 'created') throw new Error('expected created');

    // the note exists, is a sibling, text matches, positioned right after anchor
    const note = await pool.query<{
      node_type: string;
      text: string;
      position: number;
      parent_id: string | null;
    }>(`SELECT node_type, text, position, parent_id FROM paragraphs WHERE id = $1`, [first.noteId]);
    expect(note.rows[0]!.node_type).toBe('note');
    expect(note.rows[0]!.text).toBe('Verify w/ owner');
    expect(note.rows[0]!.position).toBe(11);

    const second = await acceptCommentAsNote(specId, anchorId, 0);
    expect(second.status).toBe('already-accepted');
    if (second.status === 'already-accepted') expect(second.noteId).toBe(first.noteId);

    await pool.query(`DELETE FROM paragraphs WHERE id = ANY($1::uuid[])`, [
      [anchorId, first.noteId],
    ]);
  });

  it('returns no-comment for an out-of-range index', async () => {
    const anchor = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'No comments', 20, '{}'::jsonb) RETURNING id`,
      [specId]
    );
    const out = await acceptCommentAsNote(specId, anchor.rows[0]!.id, 0);
    expect(out.status).toBe('no-comment');
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [anchor.rows[0]!.id]);
  });

  it('returns wrong-spec when the anchor belongs to another spec', async () => {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'pr1', 'x', 1) RETURNING id`,
      [specId]
    );
    const out = await acceptCommentAsNote(otherSpecId, a.rows[0]!.id, 0);
    expect(out.status).toBe('wrong-spec');
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [a.rows[0]!.id]);
  });

  it('a successful accept bumps the spec content_version by 1', async () => {
    const anchor = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Versioned anchor', 30, $2::jsonb) RETURNING id`,
      [specId, JSON.stringify({ comments: [{ author: 'A', text: 'note me', anchor: [0, 4] }] })]
    );
    const anchorId = anchor.rows[0]!.id;
    const before = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    const created = await acceptCommentAsNote(specId, anchorId, 0);
    expect(created.status).toBe('created');
    const after = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    expect(after.rows[0]!.content_version).toBe(before.rows[0]!.content_version + 1);
    // The idempotent repeat is a no-op write — it must NOT bump the version again.
    const repeat = await acceptCommentAsNote(specId, anchorId, 0);
    expect(repeat.status).toBe('already-accepted');
    const afterRepeat = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    expect(afterRepeat.rows[0]!.content_version).toBe(after.rows[0]!.content_version);
    await pool.query(`DELETE FROM paragraphs WHERE spec_id = $1 AND id <> $2`, [specId, nodeId]);
  });

  it('rejects accept-as-note on an archived spec (write gate)', async () => {
    // Clear any leftover gated row from a prior failed run so the
    // (section, source, library_id) unique constraint never collides.
    await pool.query(`DELETE FROM specs WHERE section = '00 00 09' AND title = 'gated'`);
    const gated = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id) VALUES ('00 00 09', 'gated', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    const gatedSpec = gated.rows[0]!.id;
    const anchor = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Gated anchor', 1, $2::jsonb) RETURNING id`,
      [gatedSpec, JSON.stringify({ comments: [{ author: 'A', text: 'x', anchor: [0, 1] }] })]
    );
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [gatedSpec]);
    // The composed edit gate (ADR-018) throws SpecWriteForbiddenError on an
    // archived spec — the same contract every content write obeys.
    await expect(acceptCommentAsNote(gatedSpec, anchor.rows[0]!.id, 0)).rejects.toBeInstanceOf(
      SpecWriteForbiddenError
    );
    // The write rolled back — no note was inserted.
    const notes = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM paragraphs WHERE spec_id = $1 AND node_type = 'note'`,
      [gatedSpec]
    );
    expect(notes.rows[0]!.n).toBe(0);
    await pool.query(`DELETE FROM specs WHERE id = $1`, [gatedSpec]);
  });
});
