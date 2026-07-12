import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, getParagraphWithAncestors, insertTree, updateParagraphText } from '../index.js';
import { SYSTEM_ACTOR_LABEL } from './paragraph-history.js';

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

describe('updateParagraphText — version history capture (#377)', () => {
  const HIST_SPEC_ID = 'b0000000-0000-0000-0000-00000000fe01';
  const HIST_PAR_ID = 'b0000000-0000-0000-0000-00000000fe02';

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO specs (id, section, title, source, library_id)
       VALUES ($1, '99 99 03', 'Version History Test', 'arcat',
               (SELECT id FROM libraries WHERE name = 'Default Company Master'))
       ON CONFLICT (id) DO NOTHING`,
      [HIST_SPEC_ID]
    );
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, NULL, 'pr1', 'original text', 1) ON CONFLICT (id) DO NOTHING`,
      [HIST_PAR_ID, HIST_SPEC_ID]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [HIST_SPEC_ID]);
  });

  it('version-history: WYSIWYG blur-save now snapshots prior/new text (#377)', async () => {
    const first = await updateParagraphText(HIST_SPEC_ID, HIST_PAR_ID, 'first blur-save text');
    expect(first.status).toBe('updated');

    const second = await updateParagraphText(HIST_SPEC_ID, HIST_PAR_ID, 'second blur-save text');
    expect(second.status).toBe('updated');

    const paragraphRow = await pool.query<{ base_version: number }>(
      'SELECT base_version FROM paragraphs WHERE id = $1',
      [HIST_PAR_ID]
    );
    // 1 (initial insert) -> 2 (first edit) -> 3 (second edit)
    expect(paragraphRow.rows[0]!.base_version).toBe(3);

    const history = await pool.query<{
      version: number;
      text: string;
      op: string;
      spec_id: string;
      node_type: string;
    }>(
      `SELECT version, text, op, spec_id, node_type FROM paragraph_versions
       WHERE paragraph_id = $1 ORDER BY version`,
      [HIST_PAR_ID]
    );

    // Exactly one new row per write — never zero, never more than one.
    expect(history.rows).toHaveLength(2);
    expect(history.rows[0]).toMatchObject({
      version: 2,
      text: 'first blur-save text',
      op: 'edit',
      spec_id: HIST_SPEC_ID,
      node_type: 'pr1',
    });
    expect(history.rows[1]).toMatchObject({
      version: 3,
      text: 'second blur-save text',
      op: 'edit',
      spec_id: HIST_SPEC_ID,
      node_type: 'pr1',
    });

    // The prior snapshot (from the first edit) survives untouched once a second
    // edit lands — a blur-save history shows both the prior and the new text.
    expect(history.rows[0]!.text).toBe('first blur-save text');
    expect(history.rows[1]!.text).toBe('second blur-save text');
  });

  it('stamps the resolved actorLabel on the snapshot as a real users row', async () => {
    const actorLabel = 'ph-actor-paragraphs-test';
    const result = await updateParagraphText(
      HIST_SPEC_ID,
      HIST_PAR_ID,
      'edited by a named actor',
      undefined,
      actorLabel
    );
    expect(result.status).toBe('updated');

    const joined = await pool.query<{ label: string }>(
      `SELECT u.label FROM paragraph_versions v
       JOIN users u ON u.id = v.user_id
       WHERE v.paragraph_id = $1
       ORDER BY v.version DESC LIMIT 1`,
      [HIST_PAR_ID]
    );
    expect(joined.rows[0]!.label).toBe(actorLabel);

    await pool.query('DELETE FROM users WHERE label = $1', [actorLabel]);
  });

  it('falls back to SYSTEM_ACTOR_LABEL when no actorLabel is supplied', async () => {
    const result = await updateParagraphText(HIST_SPEC_ID, HIST_PAR_ID, 'edited by no one named');
    expect(result.status).toBe('updated');

    const joined = await pool.query<{ label: string }>(
      `SELECT u.label FROM paragraph_versions v
       JOIN users u ON u.id = v.user_id
       WHERE v.paragraph_id = $1
       ORDER BY v.version DESC LIMIT 1`,
      [HIST_PAR_ID]
    );
    expect(joined.rows[0]!.label).toBe(SYSTEM_ACTOR_LABEL);
  });
});
