import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, getParagraphWithAncestors, insertTree } from '../index.js';

const SPEC_ID = 'b0000000-0000-0000-0000-000000000000';
const PART_ID = 'b0000000-0000-0000-0000-000000000001';
const ART_ID = 'b0000000-0000-0000-0000-000000000002';
const PR1_ID = 'b0000000-0000-0000-0000-000000000003';
const PR1_CONFLICTED_ID = 'b0000000-0000-0000-0000-000000000004';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [SPEC_ID, '99 99 00', 'Ancestors Test', 'arcat']
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,NULL,'part','GENERAL',1) ON CONFLICT (id) DO NOTHING`,
    [PART_ID, SPEC_ID]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'article','SCOPE',1) ON CONFLICT (id) DO NOTHING`,
    [ART_ID, SPEC_ID, PART_ID]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'pr1','Test paragraph text.',1) ON CONFLICT (id) DO NOTHING`,
    [PR1_ID, SPEC_ID, ART_ID]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, conflicts)
     VALUES ($1,$2,$3,'pr1','Conflicted paragraph.',2,$4::jsonb) ON CONFLICT (id) DO NOTHING`,
    [
      PR1_CONFLICTED_ID,
      SPEC_ID,
      ART_ID,
      JSON.stringify([{ signal: 2, reportedIlvl: 1, reportedNodeType: 'article' }]),
    ]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [SPEC_ID]);
});

describe('getParagraphWithAncestors', () => {
  it('returns node and full ancestor chain for a leaf paragraph', async () => {
    const result = await getParagraphWithAncestors(PR1_ID);
    expect(result).not.toBeNull();
    expect(result!.node.id).toBe(PR1_ID);
    expect(result!.node.nodeType).toBe('pr1');
    expect(result!.node.text).toBe('Test paragraph text.');
    expect(result!.ancestors).toHaveLength(2);
    expect(result!.ancestors[0]!.id).toBe(PART_ID); // root first
    expect(result!.ancestors[0]!.nodeType).toBe('part');
    expect(result!.ancestors[1]!.id).toBe(ART_ID);
    expect(result!.ancestors[1]!.nodeType).toBe('article');
  });

  it('returns node with empty ancestors for a root-level paragraph', async () => {
    const result = await getParagraphWithAncestors(PART_ID);
    expect(result).not.toBeNull();
    expect(result!.node.id).toBe(PART_ID);
    expect(result!.ancestors).toHaveLength(0);
  });

  it('returns null for unknown UUID', async () => {
    const result = await getParagraphWithAncestors('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });
});

describe('getParagraphWithAncestors — conflicts (#56)', () => {
  it('returns conflicts on the target node when populated', async () => {
    const result = await getParagraphWithAncestors(PR1_CONFLICTED_ID);
    expect(result).not.toBeNull();
    expect(result!.node.conflicts).toEqual([
      { signal: 2, reportedIlvl: 1, reportedNodeType: 'article' },
    ]);
  });

  it('omits conflicts on nodes and ancestors when empty', async () => {
    const result = await getParagraphWithAncestors(PR1_ID);
    expect(result).not.toBeNull();
    expect(result!.node.conflicts).toBeUndefined();
    expect(Object.keys(result!.node)).not.toContain('conflicts');
    for (const ancestor of result!.ancestors) {
      expect(ancestor.conflicts).toBeUndefined();
    }
  });
});

describe('insertTree — conflicts (#56)', () => {
  const INS_SPEC_ID = 'b0000000-0000-0000-0000-00000000c056';
  const INS_PART_ID = 'b0000000-0000-0000-0000-00000000c057';
  const INS_CONF_ID = 'b0000000-0000-0000-0000-00000000c058';

  afterAll(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [INS_SPEC_ID]);
  });

  it('persists meta.conflicts and defaults to [] when absent', async () => {
    await pool.query(
      `INSERT INTO specs (id, section, title, source) VALUES ($1, '99 99 01', 'Conflicts Insert', 'arcat')
       ON CONFLICT (id) DO NOTHING`,
      [INS_SPEC_ID]
    );
    await insertTree(
      {
        id: INS_SPEC_ID,
        section: '99 99 01',
        title: 'Conflicts Insert',
        parts: [
          {
            id: INS_PART_ID,
            type: 'part',
            text: 'GENERAL',
            children: [
              {
                id: INS_CONF_ID,
                type: 'article',
                text: 'AMBIGUOUS HEADING',
                children: [],
                meta: {
                  conflicts: [
                    { signal: 2, reportedIlvl: 2, reportedNodeType: 'pr1' },
                    { signal: 5, reportedIlvl: 0, reportedNodeType: 'part' },
                  ],
                },
              },
            ],
            meta: {},
          },
        ],
      },
      INS_SPEC_ID,
      pool
    );

    const conflicted = await pool.query<{ conflicts: unknown }>(
      'SELECT conflicts FROM paragraphs WHERE id = $1',
      [INS_CONF_ID]
    );
    expect(conflicted.rows[0]!.conflicts).toEqual([
      { signal: 2, reportedIlvl: 2, reportedNodeType: 'pr1' },
      { signal: 5, reportedIlvl: 0, reportedNodeType: 'part' },
    ]);

    const clean = await pool.query<{ conflicts: unknown }>(
      'SELECT conflicts FROM paragraphs WHERE id = $1',
      [INS_PART_ID]
    );
    expect(clean.rows[0]!.conflicts).toEqual([]);
  });
});
