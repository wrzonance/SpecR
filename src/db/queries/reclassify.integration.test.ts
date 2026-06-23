import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { setSpecEditabilityOverride, clearSpecEditabilityOverride } from './reclassify.js';

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
