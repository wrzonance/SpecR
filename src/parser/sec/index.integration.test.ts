import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../db/index.js';
import { parseSec } from './index.js';
import { insertTree, insertRefs } from '../../db/index.js';
import { assertSecSafe } from './safety.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures/sec');
const cleanupIds: string[] = [];

async function loadFixture(
  filename: string,
  onSpecCreated?: (id: string) => void
): Promise<{ specId: string; nodeCount: number; refCount: number }> {
  const xml = await readFile(join(FIXTURES, filename), 'latin1');
  const { tree, refs } = parseSec(xml);

  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source) VALUES ($1, $2, 'ufgs')
     ON CONFLICT (section, source) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
     RETURNING id`,
    [tree.section, tree.title]
  );
  const specId = r.rows[0]?.id;
  if (!specId) throw new Error(`upsert for ${filename} returned no id`);

  onSpecCreated?.(specId);

  await pool.query(`DELETE FROM spec_references WHERE source_spec_id = $1`, [specId]);
  await pool.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [specId]);

  await insertTree(tree, specId, pool);
  await insertRefs(refs, specId, pool);

  let nodeCount = 0;
  const count = (nodes: readonly import('../../ast/types.js').CsiNode[]): void => {
    for (const n of nodes) {
      nodeCount++;
      count(n.children);
    }
  };
  count(tree.parts);

  return { specId, nodeCount, refCount: refs.length };
}

afterAll(async () => {
  for (const id of cleanupIds) {
    await pool.query(`DELETE FROM specs WHERE id = $1`, [id]);
  }
});

describe('integration: 27_41_00.SEC', () => {
  let specId: string;
  let expectedNodeCount: number;

  beforeAll(async () => {
    const result = await loadFixture('27_41_00.SEC', (id) => cleanupIds.push(id));
    specId = result.specId;
    expectedNodeCount = result.nodeCount;
  });

  it('inserts spec row with correct section and source', async () => {
    const r = await pool.query<{ section: string; source: string }>(
      `SELECT section, source FROM specs WHERE id = $1`,
      [specId]
    );
    expect(r.rows[0]?.section).toBe('27 41 00');
    expect(r.rows[0]?.source).toBe('ufgs');
  });

  it('inserts all paragraph nodes', async () => {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1`,
      [specId]
    );
    expect(parseInt(r.rows[0]?.count ?? '0', 10)).toBe(expectedNodeCount);
  });

  it('inserts spec_references rows', async () => {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM spec_references WHERE source_spec_id = $1`,
      [specId]
    );
    expect(parseInt(r.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  });

  it('standard refs have non-null standard_code', async () => {
    const r = await pool.query<{ standard_code: string | null }>(
      `SELECT standard_code FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'standard' LIMIT 5`,
      [specId]
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((row) => row.standard_code !== null)).toBe(true);
  });
});

describe('integration: 27_10_00.SEC', () => {
  let specId: string;

  beforeAll(async () => {
    const result = await loadFixture('27_10_00.SEC', (id) => cleanupIds.push(id));
    specId = result.specId;
  });

  it('inserts section refs with target_spec_section populated', async () => {
    const r = await pool.query<{ target_spec_section: string | null }>(
      `SELECT target_spec_section FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'section' LIMIT 5`,
      [specId]
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((row) => row.target_spec_section !== null)).toBe(true);
  });
});

describe('integration: 27_10_00.SEC via Buffer + assertSecSafe (encoding fix)', () => {
  let specId: string | undefined;
  let expectedNodeCount = 0;

  beforeAll(async () => {
    const buf = await readFile(join(FIXTURES, '27_10_00.SEC'));
    const xml = assertSecSafe(buf);
    const { tree, refs } = parseSec(xml);
    const countNodes = (nodes: readonly import('../../ast/types.js').CsiNode[]): number =>
      nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
    expectedNodeCount = countNodes(tree.parts);

    const r = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source) VALUES ($1, $2, 'ufgs')
       ON CONFLICT (section, source) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
       RETURNING id`,
      [tree.section, tree.title]
    );
    specId = r.rows[0]?.id;
    if (!specId) throw new Error('upsert for 27_10_00.SEC returned no id');
    cleanupIds.push(specId);

    await pool.query(`DELETE FROM spec_references WHERE source_spec_id = $1`, [specId]);
    await pool.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [specId]);
    await insertTree(tree, specId, pool);
    await insertRefs(refs, specId, pool);
  });

  it('beforeAll pipeline succeeded: Buffer → assertSecSafe → parseSec → DB insert', () => {
    expect(specId).toBeDefined();
  });

  it('produces section "27 10 00"', async () => {
    const r = await pool.query<{ section: string }>(`SELECT section FROM specs WHERE id = $1`, [
      specId,
    ]);
    expect(r.rows[0]?.section).toBe('27 10 00');
  });

  it('inserts paragraphs matching parsed tree count', async () => {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1`,
      [specId]
    );
    expect(parseInt(r.rows[0]?.count ?? '0', 10)).toBe(expectedNodeCount);
  });
});

describe('integration: idempotency', () => {
  it('re-loading 27_41_00 produces same paragraph count', async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs
       WHERE spec_id = (SELECT id FROM specs WHERE section = '27 41 00' AND source = 'ufgs')`
    );
    const countBefore = parseInt(before.rows[0]?.count ?? '0', 10);
    expect(countBefore).toBeGreaterThan(0);

    const specRow = await pool.query<{ id: string }>(
      `SELECT id FROM specs WHERE section = '27 41 00' AND source = 'ufgs'`
    );
    const existingId = specRow.rows[0]?.id;
    if (existingId) {
      const xml = await readFile(join(FIXTURES, '27_41_00.SEC'), 'latin1');
      const { tree } = parseSec(xml);
      await pool.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [existingId]);
      await insertTree(tree, existingId, pool);
    }

    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs
       WHERE spec_id = (SELECT id FROM specs WHERE section = '27 41 00' AND source = 'ufgs')`
    );
    expect(parseInt(after.rows[0]?.count ?? '0', 10)).toBe(countBefore);
  });
});
