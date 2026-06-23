import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { ConventionValidationError } from './conventions.js';
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
});
