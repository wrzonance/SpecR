import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool, createLibrary } from '../index.js';
import { createSpec, persistParsedSpec, updateSpec } from './specs.js';
import type { OriginMeta } from './specs.js';
import { insertTree } from './paragraphs.js';
import { getSpecTree } from './specs.js';

const SOURCE_FACTS = {
  comments: [{ author: 'Specifier', text: 'Verify finish.', anchor: [11, 15], closed: false }],
  colors: [{ color: 'highlight:yellow', coverage: 0.25, spans: [[11, 15]] }],
  reviewer: { severity: 'coordination', count: 2 },
} as const;

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
                    meta: {
                      conflicts: [{ signal: 5, reportedIlvl: 1, reportedNodeType: 'article' }],
                      sourceFacts: SOURCE_FACTS,
                    },
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

  it('round-trips meta.conflicts on inner nodes (#56)', async () => {
    const result = await getSpecTree(treeSpecId);
    const pr1 = result!.tree.parts[0]!.children[0]!.children[0]!;
    expect(pr1.meta.conflicts).toEqual([
      { signal: 5, reportedIlvl: 1, reportedNodeType: 'article' },
    ]);
  });

  it('omits meta.conflicts when the stored array is empty (#56)', async () => {
    const result = await getSpecTree(treeSpecId);
    const part = result!.tree.parts[0]!;
    expect(part.meta.conflicts).toBeUndefined();
    expect(Object.keys(part.meta)).not.toContain('conflicts');
  });

  it('round-trips meta.sourceFacts on inner nodes (#131)', async () => {
    const result = await getSpecTree(treeSpecId);
    const pr1 = result!.tree.parts[0]!.children[0]!.children[0]!;
    expect(pr1.meta.sourceFacts).toEqual(SOURCE_FACTS);
  });

  it('omits meta.sourceFacts when the stored object is empty (#131)', async () => {
    const result = await getSpecTree(treeSpecId);
    const part = result!.tree.parts[0]!;
    expect(part.meta.sourceFacts).toBeUndefined();
    expect(Object.keys(part.meta)).not.toContain('sourceFacts');
  });

  it('backfills closed=true for a legacy suffix-closed comment fact (#262)', async () => {
    // Simulate a comment fact persisted before #262 — JSONB with no `closed`
    // key, text ending in "Closed". The read path must normalize it through the
    // schema so the API response honors the contract (closed is required) and
    // reports the comment as closed, not open.
    const legacyFacts = {
      comments: [{ author: 'Owner', text: 'Use approved product. Closed', anchor: [0, 12] }],
    };
    await pool.query(`UPDATE paragraphs SET source_facts = $1 WHERE id = $2`, [
      JSON.stringify(legacyFacts),
      '10000000-0000-0000-0000-000000000003',
    ]);
    const result = await getSpecTree(treeSpecId);
    const pr1 = result!.tree.parts[0]!.children[0]!.children[0]!;
    expect(pr1.meta.sourceFacts?.comments?.[0]?.closed).toBe(true);
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
    try {
      const r1 = await pool.query(
        `INSERT INTO specs (section, title, source, library_id) VALUES ('99 88 77.10 20', 'Shape OK', 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master')) RETURNING section`
      );
      expect(r1.rows[0]).toMatchObject({ section: '99 88 77.10 20' });
      const r2 = await pool.query(
        `INSERT INTO specs (section, title, source, library_id) VALUES ('unknown', 'Sentinel OK', 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master')) RETURNING section`
      );
      expect(r2.rows[0]).toMatchObject({ section: 'unknown' });
    } finally {
      await pool.query(
        `DELETE FROM specs WHERE section IN ('99 88 77.10 20', 'unknown') AND source = 'arcat'`
      );
    }
  });

  it('db: specs.section CHECK rejects malformed sections', async () => {
    await expect(
      pool.query(
        `INSERT INTO specs (section, title, source, library_id) VALUES ('99 8877', 'Bad', 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))`
      )
    ).rejects.toThrow(/specs_section_shape_check/);
  });

  it.each(['998877', '99.88.77', '99 8877'])(
    'db: specs.section CHECK rejects display variant %s',
    async (section) => {
      await expect(
        pool.query(
          `INSERT INTO specs (section, title, source, library_id) VALUES ($1, 'Bad', 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))`,
          [section]
        )
      ).rejects.toThrow(/specs_section_shape_check/);
    }
  );

  it.each(['998877', '99.88.77', '99 8877'])(
    'db: spec_sections.section_number CHECK rejects display variant %s',
    async (section) => {
      await expect(
        pool.query(
          `INSERT INTO spec_sections (section_number, title, division) VALUES ($1, 'Bad', '99')`,
          [section]
        )
      ).rejects.toThrow(/spec_sections_section_number_shape_check/);
    }
  );

  it('db: spec_sections shape CHECK rejects the sentinel (catalog is canonical-only)', async () => {
    await expect(
      pool.query(
        `INSERT INTO spec_sections (section_number, title, division) VALUES ('unknown', 'Bad', 'un')`
      )
    ).rejects.toThrow(/spec_sections_section_number_shape_check/);
  });
});

describe('persistParsedSpec — library routing (#92)', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM specs WHERE section = '99 66 00'`);
  });

  const inputFor = (source: 'ufgs' | 'arcat') => ({
    tree: {
      id: '',
      section: '99 66 00',
      title: 'Routing Test',
      parts: [
        {
          id: '30000000-0000-0000-0000-000000000001',
          type: 'part' as const,
          text: 'GENERAL',
          children: [],
          meta: { source },
        },
      ],
    },
    refs: [],
  });

  it('routes source=ufgs into the UFGS Reference library', async () => {
    const specId = await persistParsedSpec(inputFor('ufgs'));
    const r = await pool.query<{ name: string }>(
      `SELECT l.name FROM specs s JOIN libraries l ON l.id = s.library_id WHERE s.id = $1`,
      [specId]
    );
    expect(r.rows[0]).toMatchObject({ name: 'UFGS Reference' });
  });

  it('routes non-ufgs sources into the Default Company Master library', async () => {
    const specId = await persistParsedSpec(inputFor('arcat'));
    const r = await pool.query<{ name: string }>(
      `SELECT l.name FROM specs s JOIN libraries l ON l.id = s.library_id WHERE s.id = $1`,
      [specId]
    );
    expect(r.rows[0]).toMatchObject({ name: 'Default Company Master' });
  });

  it('re-persisting the same (section, source) upserts within one library — no duplicate', async () => {
    const first = await persistParsedSpec(inputFor('arcat'));
    const second = await persistParsedSpec(inputFor('arcat'));
    expect(second).toBe(first);
    const r = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM specs WHERE section = '99 66 00'`
    );
    expect(r.rows[0]).toMatchObject({ n: 1 });
  });
});

describe('persistParsedSpec — lineage (#93)', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM specs WHERE section = '99 67 00'`);
  });

  const input = (originMeta?: OriginMeta) => ({
    tree: {
      id: '',
      section: '99 67 00',
      title: 'Lineage Test',
      parts: [
        {
          id: '40000000-0000-0000-0000-000000000001',
          type: 'part' as const,
          text: 'GENERAL',
          children: [],
          meta: { source: 'arcat' as const },
        },
      ],
    },
    refs: [],
    ...(originMeta ? { originMeta } : {}),
  });

  it('first persist lands at content_version 1; re-upsert bumps to 2', async () => {
    const specId = await persistParsedSpec(input());
    const r1 = await pool.query('SELECT content_version FROM specs WHERE id = $1', [specId]);
    expect(r1.rows[0]).toMatchObject({ content_version: 1 });
    await persistParsedSpec(input());
    const r2 = await pool.query('SELECT content_version FROM specs WHERE id = $1', [specId]);
    expect(r2.rows[0]).toMatchObject({ content_version: 2 });
  });

  it('stores origin_meta on insert and replaces it on re-upsert when provided', async () => {
    const specId = await persistParsedSpec(
      input({ filename: 'a.sec', sha256: 'aa11', loader: 'load_files' })
    );
    const r1 = await pool.query('SELECT origin_meta FROM specs WHERE id = $1', [specId]);
    expect(r1.rows[0]).toMatchObject({
      origin_meta: { filename: 'a.sec', sha256: 'aa11', loader: 'load_files' },
    });
    await persistParsedSpec(input({ filename: 'b.sec', sha256: 'bb22', loader: 'rest:parse' }));
    const r2 = await pool.query('SELECT origin_meta FROM specs WHERE id = $1', [specId]);
    expect(r2.rows[0]).toMatchObject({
      origin_meta: { filename: 'b.sec', sha256: 'bb22', loader: 'rest:parse' },
    });
  });

  it('re-upsert without originMeta preserves previously stored origin_meta', async () => {
    const specId = await persistParsedSpec(
      input({ filename: 'a.sec', sha256: 'aa11', loader: 'load_files' })
    );
    await persistParsedSpec(input());
    const r = await pool.query('SELECT origin_meta FROM specs WHERE id = $1', [specId]);
    expect(r.rows[0]).toMatchObject({
      origin_meta: { filename: 'a.sec', sha256: 'aa11', loader: 'load_files' },
    });
  });

  it('new specs carry no lineage: parent_spec_id and origin_version are null (#94 populates them)', async () => {
    const specId = await persistParsedSpec(input());
    const r = await pool.query('SELECT parent_spec_id, origin_version FROM specs WHERE id = $1', [
      specId,
    ]);
    expect(r.rows[0]).toMatchObject({ parent_spec_id: null, origin_version: null });
  });
});

describe('persistParsedSpec — division general reconciliation', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM specs WHERE section = '98 00 00'`);
  });

  it('exact NN 00 00 ingest establishes the library division general spec', async () => {
    const specId = await persistParsedSpec({
      tree: {
        id: '',
        section: '98 00 00',
        title: 'Division 98 General Requirements',
        parts: [
          {
            id: '98000000-0000-0000-0000-000000000001',
            type: 'part',
            text: 'GENERAL',
            children: [],
            meta: { source: 'arcat' },
          },
        ],
      },
      refs: [],
    });

    const result = await pool.query<{ general_spec_id: string; detection_method: string }>(
      `SELECT general_spec_id, detection_method
       FROM division_general_specs
       WHERE division = '98'
         AND library_id = (SELECT id FROM libraries WHERE name = 'Default Company Master')`
    );
    expect(result.rows[0]).toEqual({
      general_spec_id: specId,
      detection_method: 'exact_section',
    });
  });
});

describe('updateSpec — content_version bump (#93)', () => {
  it('bumps content_version when title changes; no-op update does not bump', async () => {
    const id = await createSpec({ section: '99 00 00', title: 'V1', source: 'arcat' });
    await updateSpec(id, { title: 'V2' });
    const r1 = await pool.query('SELECT content_version FROM specs WHERE id = $1', [id]);
    expect(r1.rows[0]).toMatchObject({ content_version: 2 });
    await updateSpec(id, { title: 'V2' }); // same value — no content change
    const r2 = await pool.query('SELECT content_version FROM specs WHERE id = $1', [id]);
    expect(r2.rows[0]).toMatchObject({ content_version: 2 });
  });

  it('bumps content_version when section changes', async () => {
    const id = await createSpec({ section: '99 00 00', title: 'V1', source: 'arcat' });
    await updateSpec(id, { section: '99 00 10' });
    const r = await pool.query('SELECT content_version FROM specs WHERE id = $1', [id]);
    expect(r.rows[0]).toMatchObject({ content_version: 2 });
    await pool.query(`DELETE FROM specs WHERE section = '99 00 10'`);
  });
});

describe('persistParsedSpec — explicit libraryId target (O-8)', () => {
  const TEST_LIB = 'lib-persist-target-test';

  afterEach(async () => {
    await pool.query(
      `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name = $1)`,
      [TEST_LIB]
    );
    await pool.query(`DELETE FROM libraries WHERE name = $1`, [TEST_LIB]);
  });

  it('persists the spec into the supplied library, not the source-derived one', async () => {
    const lib = await createLibrary({ tier: 'company', name: TEST_LIB, owner: TEST_LIB });
    // A 'ufgs' source would normally route to the UFGS Reference library — the
    // explicit libraryId must win. Random paragraph id so reruns never collide.
    const specId = await persistParsedSpec({
      tree: {
        id: 'placeholder',
        section: '09 91 26',
        title: 'Interior Painting',
        parts: [
          {
            id: randomUUID(),
            type: 'part',
            text: 'PART 1 GENERAL',
            children: [],
            meta: { source: 'ufgs' },
          },
        ],
      },
      refs: [],
      libraryId: lib.id,
    });
    const row = await pool.query<{ library_id: string }>(
      `SELECT library_id FROM specs WHERE id = $1`,
      [specId]
    );
    expect(row.rows[0]?.library_id).toBe(lib.id);
  });
});
