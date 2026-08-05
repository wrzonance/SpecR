import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  pool,
  getParagraphWithAncestors,
  insertTree,
  updateParagraphText,
  createSpec,
  getSpecTree,
} from '../index.js';
import { SYSTEM_ACTOR_LABEL } from './paragraph-history.js';
import { fetchSubtreeNode } from './paragraphs.js';
import { findAnchoredParagraph } from '../../parser/index.js';
import { UUID_TAG_PREFIX } from '../../ast/index.js';
import type { ObjectBlobNode, ObjectMeta } from '../../ast/index.js';

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
    try {
      expect(joined.rows[0]!.label).toBe(actorLabel);
    } finally {
      // Run cleanup even if the assertion throws — a leaked users row (label is
      // UNIQUE) would fail later runs that re-claim it.
      await pool.query('DELETE FROM users WHERE label = $1', [actorLabel]);
    }
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

const TABLE_OBJECT_META = {
  kind: 'table' as const,
  floating: false,
  generation: 'drawingml' as const,
  rows: 1,
  columns: 2,
  blob: [{ 'w:tbl': [{ 'w:tblPr': [] }] }],
};

describe('body objects — read-path parity (#300, ADR-072)', () => {
  const OBJ_PART_ID = 'd0000000-0000-0000-0000-000000000002';
  const OBJ_OBJECT_ID = 'd0000000-0000-0000-0000-000000000003';
  const OBJ_TEXT_ID = 'd0000000-0000-0000-0000-000000000004';
  let objSpecId: string;

  beforeEach(async () => {
    objSpecId = await createSpec({ section: '99 00 00', title: 'Object Parity', source: 'arcat' });
    await insertTree(
      {
        id: objSpecId,
        section: '99 00 00',
        title: 'Object Parity',
        parts: [
          {
            id: OBJ_PART_ID,
            type: 'part',
            text: 'GENERAL',
            children: [
              {
                id: OBJ_OBJECT_ID,
                type: 'object',
                text: '[TABLE]',
                children: [
                  {
                    id: OBJ_TEXT_ID,
                    type: 'objectText',
                    text: 'Cell one text',
                    children: [],
                    meta: {},
                  },
                ],
                meta: { object: TABLE_OBJECT_META },
              },
            ],
            meta: {},
          },
        ],
      },
      objSpecId,
      pool
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [objSpecId]);
  });

  it('fetchSubtreeNode (paragraphs.ts) round-trips meta.object, verbatim', async () => {
    const node = await fetchSubtreeNode(pool, objSpecId, OBJ_OBJECT_ID);
    expect(node).not.toBeNull();
    expect(node!.type).toBe('object');
    expect(node!.meta.object).toEqual(TABLE_OBJECT_META);
  });

  it('getParagraphWithAncestors round-trips meta.object on the target node', async () => {
    const result = await getParagraphWithAncestors(OBJ_OBJECT_ID);
    expect(result).not.toBeNull();
    expect(result!.node.nodeType).toBe('object');
    expect(result!.node.object).toEqual(TABLE_OBJECT_META);
  });

  it('parity: subtree read (paragraphs.ts) and full-tree read (specs.ts) produce an identical object node shape', async () => {
    const subtreeNode = await fetchSubtreeNode(pool, objSpecId, OBJ_OBJECT_ID);
    const fullTree = await getSpecTree(objSpecId);
    const fullTreeNode = fullTree!.tree.parts[0]!.children[0]!;
    expect(subtreeNode).toEqual(fullTreeNode);
  });
});

// #650 — vanishCharStyleIds must reach a real DATABASE column and come back,
// not merely round-trip in memory. PR #536 (`pageSize`) is the precedent this
// block exists to rule out: an additive SpecTree field that every in-memory
// test passed while the save/load mappers silently dropped it. So each case
// below drives the CANONICAL write path (insertTree, the same one the DOCX
// import uses) and then asserts twice — once against the raw `object_data`
// JSONB column via SQL (proof the value is on disk, not in a cache), and once
// through the real read mappers (getSpecTree / fetchSubtreeNode).
const VANISH_STYLE_OBJECT_META: ObjectMeta = {
  kind: 'table',
  floating: false,
  generation: 'drawingml',
  rows: 1,
  columns: 1,
  vanishCharStyleIds: ['AlsoHidden', 'HiddenChar'],
  blob: [{ 'w:tbl': [{ 'w:tblPr': [] }] }],
};

describe('body objects — vanishCharStyleIds DB persistence (#650)', () => {
  const VS_PART_ID = 'd0000000-0000-0000-0000-000000000650';
  const VS_OBJECT_ID = 'd0000000-0000-0000-0000-000000000651';
  let vsSpecId: string;

  async function insertObjectTree(meta: ObjectMeta): Promise<void> {
    await insertTree(
      {
        id: vsSpecId,
        section: '99 00 50',
        title: 'Vanish Style Persistence',
        parts: [
          {
            id: VS_PART_ID,
            type: 'part',
            text: 'GENERAL',
            children: [
              {
                id: VS_OBJECT_ID,
                type: 'object',
                text: '[TABLE]',
                children: [],
                meta: { object: meta },
              },
            ],
            meta: {},
          },
        ],
      },
      vsSpecId,
      pool
    );
  }

  beforeEach(async () => {
    vsSpecId = await createSpec({
      section: '99 00 50',
      title: 'Vanish Style Persistence',
      source: 'arcat',
    });
  });

  afterEach(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [vsSpecId]);
  });

  it('persistence: vanishCharStyleIds is written to the object_data JSONB COLUMN by insertTree', async () => {
    await insertObjectTree(VANISH_STYLE_OBJECT_META);

    // Read the column directly — a passing in-memory assertion cannot prove
    // this, and the #536 regression is exactly a value that never got here.
    const raw = await pool.query<{ ids: readonly string[] | null }>(
      `SELECT object_data->'vanishCharStyleIds' AS ids FROM paragraphs WHERE id = $1`,
      [VS_OBJECT_ID]
    );
    expect(raw.rows[0]!.ids).toEqual(['AlsoHidden', 'HiddenChar']);
  });

  it('round-trip: getSpecTree and fetchSubtreeNode both return vanishCharStyleIds verbatim', async () => {
    await insertObjectTree(VANISH_STYLE_OBJECT_META);

    const fullTree = await getSpecTree(vsSpecId);
    const treeNode = fullTree!.tree.parts[0]!.children[0]!;
    expect(treeNode.meta.object).toEqual(VANISH_STYLE_OBJECT_META);
    expect(treeNode.meta.object!.vanishCharStyleIds).toEqual(['AlsoHidden', 'HiddenChar']);

    const subtreeNode = await fetchSubtreeNode(pool, vsSpecId, VS_OBJECT_ID);
    expect(subtreeNode!.meta.object!.vanishCharStyleIds).toEqual(['AlsoHidden', 'HiddenChar']);
  });

  it('backfill: an object with NO vanishCharStyleIds persists and reads back with the key absent, never fabricated', async () => {
    await insertObjectTree(TABLE_OBJECT_META);

    const raw = await pool.query<{ ids: readonly string[] | null }>(
      `SELECT object_data->'vanishCharStyleIds' AS ids FROM paragraphs WHERE id = $1`,
      [VS_OBJECT_ID]
    );
    expect(raw.rows[0]!.ids).toBeNull();

    const fullTree = await getSpecTree(vsSpecId);
    const treeNode = fullTree!.tree.parts[0]!.children[0]!;
    expect(treeNode.meta.object!.vanishCharStyleIds).toBeUndefined();
  });
});

// #519 (ADR-072 decision 3) — the write-path wiring in applyParagraphUpdate:
// an `object` row is locked (its content is a captured OOXML blob, never a
// plain text write); an `objectText` row's edit is dispatched into its
// parent object row's blob instead of only updating its own `text` column.

/** One anchored interior paragraph whose w:sdtContent carries MULTIPLE runs
 * (a realistic "bold World" mid-run-break shape) — mirrors
 * object-text-edit.integration.test.ts's own anchoredParagraph helper, built
 * directly (not imported: db/ may only import parser/'s public barrel, and
 * that helper lives in a sibling test file, not a module export). */
function multiRunAnchoredParagraph(uuid: string, runTexts: readonly string[]): ObjectBlobNode {
  const runs = runTexts.map((text) => ({ 'w:r': [{ 'w:t': [{ '#text': text }] }] }));
  return {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${uuid}` } }] },
      { 'w:sdtContent': [{ 'w:p': runs }] },
    ],
  } as ObjectBlobNode;
}

function multiRunTableMeta(anchorUuid: string, runTexts: readonly string[]): ObjectMeta {
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: 1,
    blob: [{ 'w:tc': [multiRunAnchoredParagraph(anchorUuid, runTexts)] }],
  };
}

/** Two-cell table meta with a DIFFERENT anchor per cell — the shape the
 * concurrency test below needs: two `objectText` children of the SAME
 * `object` row, each independently addressable so concurrent edits target
 * different child rows while sharing one parent blob. */
function twoAnchorTableMeta(
  uuidA: string,
  textA: string,
  uuidB: string,
  textB: string
): ObjectMeta {
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: 2,
    blob: [
      { 'w:tc': [multiRunAnchoredParagraph(uuidA, [textA])] },
      { 'w:tc': [multiRunAnchoredParagraph(uuidB, [textB])] },
    ],
  };
}

describe('updateParagraphText — object write path (#519, ADR-072 decision 3)', () => {
  const OW_PART_ID = 'e0000000-0000-0000-0000-000000000001';
  const OW_OBJECT_ID = 'e0000000-0000-0000-0000-000000000002';
  const OW_TEXT_ID = 'e0000000-0000-0000-0000-000000000003';
  let owSpecId: string;

  beforeEach(async () => {
    owSpecId = await createSpec({
      section: '99 00 01',
      title: 'Object Write Path',
      source: 'arcat',
    });
    await insertTree(
      {
        id: owSpecId,
        section: '99 00 01',
        title: 'Object Write Path',
        parts: [
          {
            id: OW_PART_ID,
            type: 'part',
            text: 'GENERAL',
            children: [
              {
                id: OW_OBJECT_ID,
                type: 'object',
                text: '[TABLE]',
                children: [
                  {
                    id: OW_TEXT_ID,
                    type: 'objectText',
                    text: 'Hello World',
                    children: [],
                    meta: {},
                  },
                ],
                meta: { object: multiRunTableMeta(OW_TEXT_ID, ['Hello ', 'World']) },
              },
            ],
            meta: {},
          },
        ],
      },
      owSpecId,
      pool
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [owSpecId]);
  });

  it('invariant: locked-object guard parity — the object row is rejected unchanged, never written', async () => {
    const before = await pool.query<{ text: string; base_version: number }>(
      'SELECT text, base_version FROM paragraphs WHERE id = $1',
      [OW_OBJECT_ID]
    );

    const result = await updateParagraphText(owSpecId, OW_OBJECT_ID, 'attempted direct rewrite');

    expect(result).toEqual({ status: 'locked-object', nodeType: 'object' });
    const after = await pool.query<{ text: string; base_version: number }>(
      'SELECT text, base_version FROM paragraphs WHERE id = $1',
      [OW_OBJECT_ID]
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it(
    "invariant: interior text reaches the DOCX only through the parent object's blob — " +
      'updating an objectText row rewrites the parent object_data.blob, preserving the ' +
      'original multi-run interior paragraph and blanking every run but the first ' +
      '(faithful single-value rewrite)',
    async () => {
      const result = await updateParagraphText(owSpecId, OW_TEXT_ID, 'Rewritten single run');
      expect(result.status).toBe('updated');

      const objectRow = await pool.query<{ object_data: ObjectMeta }>(
        'SELECT object_data FROM paragraphs WHERE id = $1',
        [OW_OBJECT_ID]
      );
      const found = findAnchoredParagraph(objectRow.rows[0]!.object_data.blob, OW_TEXT_ID);
      expect(found).toEqual({
        'w:p': [
          { 'w:r': [{ 'w:t': [{ '#text': 'Rewritten single run' }] }] },
          { 'w:r': [{ 'w:t': [{ '#text': '' }] }] },
        ],
      });

      // Read-path parity: the objectText row's own text column keeps step with
      // the general write, even though DOCX regeneration reads the blob only.
      const textRow = await pool.query<{ text: string }>(
        'SELECT text FROM paragraphs WHERE id = $1',
        [OW_TEXT_ID]
      );
      expect(textRow.rows[0]!.text).toBe('Rewritten single run');
    }
  );

  it('throws DatabaseError when an objectText row somehow has no parent to rewrite into (data-integrity guard)', async () => {
    const orphan = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'objectText', 'orphan', 99) RETURNING id`,
      [owSpecId]
    );
    const orphanId = orphan.rows[0]!.id;

    await expect(updateParagraphText(owSpecId, orphanId, 'new text')).rejects.toThrow(
      /has no parent object row/
    );
  });
});

// #519 review finding: object-text-edit.integration.test.ts's own concurrent-safety
// test calls rewriteObjectTextBlob directly, so it never acquires the child-row
// FOR UPDATE lock — only fetchUpdateOwnerRow (inside applyParagraphUpdate) does
// that. The tests below drive the SAME concurrency through updateParagraphText
// itself, so both locks in the documented "lock the child row, then lock the
// parent row" ordering (fetchUpdateOwnerRow's `SELECT ... FOR UPDATE` on the
// objectText row, then rewriteObjectTextBlob's on its parent object row) are
// actually exercised end-to-end, not just the parent-row half.
describe('updateParagraphText — concurrent objectText edits exercise the real lock ordering (#519 review finding)', () => {
  const CO_PART_ID = 'e1000000-0000-0000-0000-000000000001';
  const CO_OBJECT_ID = 'e1000000-0000-0000-0000-000000000002';
  const CO_TEXT_A_ID = 'e1000000-0000-0000-0000-000000000003';
  const CO_TEXT_B_ID = 'e1000000-0000-0000-0000-000000000004';
  let coSpecId: string;

  beforeEach(async () => {
    coSpecId = await createSpec({
      section: '99 00 02',
      title: 'Concurrent Object Write Path',
      source: 'arcat',
    });
    await insertTree(
      {
        id: coSpecId,
        section: '99 00 02',
        title: 'Concurrent Object Write Path',
        parts: [
          {
            id: CO_PART_ID,
            type: 'part',
            text: 'GENERAL',
            children: [
              {
                id: CO_OBJECT_ID,
                type: 'object',
                text: '[TABLE]',
                children: [
                  {
                    id: CO_TEXT_A_ID,
                    type: 'objectText',
                    text: 'original A',
                    children: [],
                    meta: {},
                  },
                  {
                    id: CO_TEXT_B_ID,
                    type: 'objectText',
                    text: 'original B',
                    children: [],
                    meta: {},
                  },
                ],
                meta: {
                  object: twoAnchorTableMeta(
                    CO_TEXT_A_ID,
                    'original A',
                    CO_TEXT_B_ID,
                    'original B'
                  ),
                },
              },
            ],
            meta: {},
          },
        ],
      },
      coSpecId,
      pool
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [coSpecId]);
  });

  it(
    'two concurrent updateParagraphText calls on DIFFERENT objectText children of the SAME ' +
      'object row both land — each call is its own self-committing transaction (mirrors ' +
      "object-text-edit.integration.test.ts's own concurrent-call pattern), so the second " +
      "writer's fetchUpdateOwnerRow/rewriteObjectTextBlob locks queue behind the first's " +
      'instead of racing a lost update onto the shared object_data column',
    async () => {
      const [resultA, resultB] = await Promise.all([
        updateParagraphText(coSpecId, CO_TEXT_A_ID, 'concurrent A'),
        updateParagraphText(coSpecId, CO_TEXT_B_ID, 'concurrent B'),
      ]);
      expect(resultA.status).toBe('updated');
      expect(resultB.status).toBe('updated');

      const objectRow = await pool.query<{ object_data: ObjectMeta }>(
        'SELECT object_data FROM paragraphs WHERE id = $1',
        [CO_OBJECT_ID]
      );
      const blob = objectRow.rows[0]!.object_data.blob;
      expect(findAnchoredParagraph(blob, CO_TEXT_A_ID)).toEqual({
        'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': 'concurrent A' }] }] }],
      });
      expect(findAnchoredParagraph(blob, CO_TEXT_B_ID)).toEqual({
        'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': 'concurrent B' }] }] }],
      });

      // Read-path parity for both children too — rewriteObjectTextIfNeeded runs
      // alongside the generic UPDATE, never instead of it, for either writer.
      const textRows = await pool.query<{ id: string; text: string }>(
        'SELECT id, text FROM paragraphs WHERE id = ANY($1::uuid[])',
        [[CO_TEXT_A_ID, CO_TEXT_B_ID]]
      );
      const textById = new Map(textRows.rows.map((row) => [row.id, row.text]));
      expect(textById.get(CO_TEXT_A_ID)).toBe('concurrent A');
      expect(textById.get(CO_TEXT_B_ID)).toBe('concurrent B');
    }
  );
});
