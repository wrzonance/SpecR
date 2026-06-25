import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, getParagraphWithAncestors, insertTree, setParagraphVanish } from '../index.js';

const SPEC_ID = 'b0000000-0000-0000-0000-000000000000';
const PART_ID = 'b0000000-0000-0000-0000-000000000001';
const ART_ID = 'b0000000-0000-0000-0000-000000000002';
const PR1_ID = 'b0000000-0000-0000-0000-000000000003';
const PR1_CONFLICTED_ID = 'b0000000-0000-0000-0000-000000000004';
const PR1_FACTS_ID = 'b0000000-0000-0000-0000-000000000005';

const SOURCE_FACTS = {
  comments: [
    { author: 'Specifier', text: 'Check mounting height.', anchor: [0, 10], closed: false },
  ],
  colors: [{ color: '0000FF', coverage: 0.5, spans: [[0, 10]] }],
  reviewer: { severity: 'info', count: 1 },
} as const;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
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
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, source_facts)
     VALUES ($1,$2,$3,'pr1','Source fact paragraph.',3,$4::jsonb) ON CONFLICT (id) DO NOTHING`,
    [PR1_FACTS_ID, SPEC_ID, ART_ID, JSON.stringify(SOURCE_FACTS)]
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

describe('getParagraphWithAncestors — source facts (#131)', () => {
  it('returns source facts on the target node when populated', async () => {
    const result = await getParagraphWithAncestors(PR1_FACTS_ID);
    expect(result).not.toBeNull();
    expect(result!.node.sourceFacts).toEqual(SOURCE_FACTS);
  });

  it('omits sourceFacts on nodes and ancestors when empty', async () => {
    const result = await getParagraphWithAncestors(PR1_ID);
    expect(result).not.toBeNull();
    expect(result!.node.sourceFacts).toBeUndefined();
    expect(Object.keys(result!.node)).not.toContain('sourceFacts');
    for (const ancestor of result!.ancestors) {
      expect(ancestor.sourceFacts).toBeUndefined();
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
      `INSERT INTO specs (id, section, title, source, library_id)
       VALUES ($1, '99 99 01', 'Conflicts Insert', 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
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

describe('insertTree — source facts (#131)', () => {
  const INS_SPEC_ID = 'b0000000-0000-0000-0000-00000000f131';
  const INS_PART_ID = 'b0000000-0000-0000-0000-00000000f132';
  const INS_FACTS_ID = 'b0000000-0000-0000-0000-00000000f133';

  afterAll(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [INS_SPEC_ID]);
  });

  it('persists meta.sourceFacts and defaults to {} when absent', async () => {
    await pool.query(
      `INSERT INTO specs (id, section, title, source, library_id)
       VALUES ($1, '99 99 02', 'Source Facts Insert', 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
       ON CONFLICT (id) DO NOTHING`,
      [INS_SPEC_ID]
    );
    await insertTree(
      {
        id: INS_SPEC_ID,
        section: '99 99 02',
        title: 'Source Facts Insert',
        parts: [
          {
            id: INS_PART_ID,
            type: 'part',
            text: 'GENERAL',
            children: [
              {
                id: INS_FACTS_ID,
                type: 'article',
                text: 'COLORED HEADING',
                children: [],
                meta: { sourceFacts: SOURCE_FACTS },
              },
            ],
            meta: {},
          },
        ],
      },
      INS_SPEC_ID,
      pool
    );

    const withFacts = await pool.query<{ sourceFacts: unknown }>(
      'SELECT source_facts AS "sourceFacts" FROM paragraphs WHERE id = $1',
      [INS_FACTS_ID]
    );
    expect(withFacts.rows[0]!.sourceFacts).toEqual(SOURCE_FACTS);

    const clean = await pool.query<{ sourceFacts: unknown }>(
      'SELECT source_facts AS "sourceFacts" FROM paragraphs WHERE id = $1',
      [INS_PART_ID]
    );
    expect(clean.rows[0]!.sourceFacts).toEqual({});
  });
});

describe('setParagraphVanish — reversible paragraph removal (#251)', () => {
  let specId: string;
  let nodeId: string;
  let noteId: string;
  let articleId: string;
  let otherSpecId: string;

  beforeAll(async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    const libraryId = lib.rows[0]!.id;
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 81', 'Vanish DB Test', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    specId = spec.rows[0]!.id;
    const node = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'pr1', 'Removable paragraph.', 1) RETURNING id`,
      [specId]
    );
    nodeId = node.rows[0]!.id;
    // A note and an article heading — types the renderers cannot suppress, so
    // removal must reject them rather than store a vanish that silently lies.
    const note = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'note', 'Editorial note.', 2) RETURNING id`,
      [specId]
    );
    noteId = note.rows[0]!.id;
    const article = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'article', 'SUMMARY', 3) RETURNING id`,
      [specId]
    );
    articleId = article.rows[0]!.id;
    const other = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 80', 'Vanish DB Other', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    otherSpecId = other.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [[specId, otherSpecId]]);
  });

  it('vanishes a paragraph (reversible removal), returning the updated node', async () => {
    const r = await setParagraphVanish(specId, nodeId, true);
    expect(r.status).toBe('updated');
    if (r.status === 'updated') expect(r.node.meta.vanish).toBe(true);
    const row = await pool.query<{ vanish: boolean }>(
      `SELECT vanish FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(row.rows[0]!.vanish).toBe(true);
  });

  it('un-vanishes a paragraph (reverses removal)', async () => {
    await setParagraphVanish(specId, nodeId, true);
    const r = await setParagraphVanish(specId, nodeId, false);
    expect(r.status).toBe('updated');
    if (r.status === 'updated') expect(r.node.meta.vanish).toBeUndefined();
  });

  it('returns not-found for an unknown node', async () => {
    const r = await setParagraphVanish(specId, '00000000-0000-0000-0000-000000000000', true);
    expect(r.status).toBe('not-found');
  });

  it('returns wrong-spec when the node belongs to another spec', async () => {
    const r = await setParagraphVanish(otherSpecId, nodeId, true);
    expect(r.status).toBe('wrong-spec');
  });

  it('bumps specs.content_version on a successful vanish', async () => {
    await setParagraphVanish(specId, nodeId, false); // ensure an effective change
    const before = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    await setParagraphVanish(specId, nodeId, true);
    const after = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    expect(after.rows[0]!.content_version).toBeGreaterThan(before.rows[0]!.content_version);
  });

  it('rejects a note node — renderers cannot suppress it (not-removable)', async () => {
    const r = await setParagraphVanish(specId, noteId, true);
    expect(r.status).toBe('not-removable');
    if (r.status === 'not-removable') expect(r.nodeType).toBe('note');
    const row = await pool.query<{ vanish: boolean }>(
      `SELECT vanish FROM paragraphs WHERE id = $1`,
      [noteId]
    );
    expect(row.rows[0]!.vanish).toBe(false); // flag never written
  });

  it('rejects an article heading — renderers cannot suppress it (not-removable)', async () => {
    const r = await setParagraphVanish(specId, articleId, true);
    expect(r.status).toBe('not-removable');
    if (r.status === 'not-removable') expect(r.nodeType).toBe('article');
  });

  it('idempotent no-op: re-removing an already-removed node does not bump content_version', async () => {
    await setParagraphVanish(specId, nodeId, true); // now vanished
    const before = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    const r = await setParagraphVanish(specId, nodeId, true); // no-op
    expect(r.status).toBe('updated');
    if (r.status === 'updated') expect(r.node.meta.vanish).toBe(true);
    const after = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    expect(after.rows[0]!.content_version).toBe(before.rows[0]!.content_version);
  });

  it('idempotent no-op: re-restoring an already-restored node does not bump base_version', async () => {
    await setParagraphVanish(specId, nodeId, false); // now restored
    const before = await pool.query<{ base_version: number }>(
      `SELECT base_version FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    const r = await setParagraphVanish(specId, nodeId, false); // no-op
    expect(r.status).toBe('updated');
    const after = await pool.query<{ base_version: number }>(
      `SELECT base_version FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(after.rows[0]!.base_version).toBe(before.rows[0]!.base_version);
  });
});
