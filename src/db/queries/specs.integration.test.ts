import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { pool } from '../index.js';
import { createSpec } from './specs.js';
import { insertTree } from './paragraphs.js';
import { getSpecTree } from './specs.js';

afterEach(async () => {
  await pool.query("DELETE FROM specs WHERE section = '99 00 00'");
});

describe('getSpecTree', () => {
  let treeSpecId: string;

  beforeEach(async () => {
    treeSpecId = await createSpec({ section: '99 00 00', title: 'Tree Test', source: 'arcat' });
    await insertTree(
      {
        id: treeSpecId,
        section: '99 00 00',
        title: 'Tree Test',
        parts: [
          {
            id: '10000000-0000-0000-0000-000000000001',
            type: 'part',
            text: 'GENERAL',
            children: [
              {
                id: '10000000-0000-0000-0000-000000000002',
                type: 'article',
                text: 'REFERENCES',
                children: [
                  {
                    id: '10000000-0000-0000-0000-000000000003',
                    type: 'pr1',
                    text: 'Coordinate work.',
                    children: [],
                    meta: {},
                  },
                ],
                meta: {},
              },
            ],
            meta: {},
          },
        ],
      },
      treeSpecId,
      pool
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [treeSpecId]);
  });

  it('returns null for unknown id', async () => {
    const result = await getSpecTree('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('reconstructs part → article → pr1 hierarchy', async () => {
    const result = await getSpecTree(treeSpecId);
    expect(result).not.toBeNull();
    expect(result!.tree.parts).toHaveLength(1);
    expect(result!.tree.parts[0]!.type).toBe('part');
    expect(result!.tree.parts[0]!.children).toHaveLength(1);
    expect(result!.tree.parts[0]!.children[0]!.type).toBe('article');
    expect(result!.tree.parts[0]!.children[0]!.children).toHaveLength(1);
    expect(result!.tree.parts[0]!.children[0]!.children[0]!.type).toBe('pr1');
  });

  it('returns empty references array when no refs exist', async () => {
    const result = await getSpecTree(treeSpecId);
    expect(result!.references).toEqual([]);
  });
});

describe('createSpec', () => {
  it('inserts a spec row and returns the UUID', async () => {
    const id = await createSpec({ section: '99 00 00', title: 'Test Spec', source: 'arcat' });
    expect(id).toMatch(/^[\da-f-]{36}$/);

    const result = await pool.query('SELECT id, section, title, source FROM specs WHERE id = $1', [
      id,
    ]);
    expect(result.rows[0]).toMatchObject({
      section: '99 00 00',
      title: 'Test Spec',
      source: 'arcat',
    });
  });

  it('createSpec with explicit pool client works', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = await createSpec({ section: '99 00 00', title: 'TX Test', source: 'cpi' }, client);
      expect(id).toMatch(/^[\da-f-]{36}$/);
      await client.query('ROLLBACK'); // rolled back, nothing inserted
    } finally {
      client.release();
    }
  });
});

describe('migration 013 — section shape CHECK constraints', () => {
  it('db: specs.section CHECK accepts expanded shapes and the unknown sentinel', async () => {
    const r1 = await pool.query(
      `INSERT INTO specs (section, title, source) VALUES ('99 88 77.10 20', 'Shape OK', 'arcat') RETURNING section`
    );
    expect(r1.rows[0]).toMatchObject({ section: '99 88 77.10 20' });
    const r2 = await pool.query(
      `INSERT INTO specs (section, title, source) VALUES ('unknown', 'Sentinel OK', 'arcat') RETURNING section`
    );
    expect(r2.rows[0]).toMatchObject({ section: 'unknown' });
    await pool.query(
      `DELETE FROM specs WHERE section IN ('99 88 77.10 20', 'unknown') AND source = 'arcat'`
    );
  });

  it('db: specs.section CHECK rejects malformed sections', async () => {
    await expect(
      pool.query(`INSERT INTO specs (section, title, source) VALUES ('99 8877', 'Bad', 'arcat')`)
    ).rejects.toThrow(/specs_section_shape_check/);
  });

  it('db: spec_sections shape CHECK rejects the sentinel (catalog is canonical-only)', async () => {
    await expect(
      pool.query(
        `INSERT INTO spec_sections (section_number, title, division) VALUES ('unknown', 'Bad', 'un')`
      )
    ).rejects.toThrow(/spec_sections_section_number_shape_check/);
  });
});
