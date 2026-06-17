import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pool } from '../index.js';
import { createSpec } from './specs.js';
import { getSpecTree } from './specs.js';
import { insertTree } from './paragraphs.js';
import {
  storeClassifications,
  setEditabilityOverride,
  clearEditabilityOverride,
} from './editability.js';
import type { ClassifyResult } from '../../conventions/index.js';

const PR1_ID = '20000000-0000-0000-0000-000000000003';
const PART_ID = '20000000-0000-0000-0000-000000000001';
const ARTICLE_ID = '20000000-0000-0000-0000-000000000002';

// A second, structurally identical spec with DISTINCT node ids — `id` is the
// paragraphs PK, so two specs can never share a node id.
const SIB_PR1_ID = '30000000-0000-0000-0000-000000000003';
const SIB_PART_ID = '30000000-0000-0000-0000-000000000001';
const SIB_ARTICLE_ID = '30000000-0000-0000-0000-000000000002';

// The machine's first verdict and a deliberately DIFFERENT reclassify verdict,
// used to prove the override is never clobbered by a re-run.
const FIRST: ClassifyResult = [
  {
    nodeId: PR1_ID,
    editability: 'editable',
    confidence: 0.9,
    evidence: [{ rule: 'colorMeanings[0000FF]', fact: 'colors[0]' }],
  },
];
const RECLASSIFIED: ClassifyResult = [
  {
    nodeId: PR1_ID,
    editability: 'locked',
    confidence: 0.4,
    evidence: [{ rule: 'defaultEditability', detail: 'color cleared on second pass' }],
  },
];

interface NodeIds {
  readonly part: string;
  readonly article: string;
  readonly pr1: string;
}

async function seedSpec(section: string, ids: NodeIds): Promise<string> {
  const specId = await createSpec({ section, title: 'Editability Test', source: 'arcat' });
  await insertTree(
    {
      id: specId,
      section,
      title: 'Editability Test',
      parts: [
        {
          id: ids.part,
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: ids.article,
              type: 'article',
              text: 'REFERENCES',
              meta: {},
              children: [
                { id: ids.pr1, type: 'pr1', text: 'Coordinate work.', meta: {}, children: [] },
              ],
            },
          ],
        },
      ],
    },
    specId,
    pool
  );
  return specId;
}

async function readPr1(specId: string) {
  const result = await getSpecTree(specId);
  return result!.tree.parts[0]!.children[0]!.children[0]!;
}

describe('editability storage (O-7 / #134)', () => {
  let specId: string;

  beforeEach(async () => {
    specId = await seedSpec('99 00 01', { part: PART_ID, article: ARTICLE_ID, pr1: PR1_ID });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM specs WHERE section LIKE '99 00 0%'");
  });

  it('round-trip: store classification → getSpecTree reads back identical', async () => {
    await storeClassifications(specId, FIRST);
    const pr1 = await readPr1(specId);
    expect(pr1.meta.editability).toEqual({
      value: 'editable',
      confidence: 0.9,
      evidence: [{ rule: 'colorMeanings[0000FF]', fact: 'colors[0]' }],
    });
    expect(pr1.meta.editability?.override).toBeUndefined();
  });

  it('omits meta.editability entirely for an unclassified paragraph', async () => {
    const pr1 = await readPr1(specId);
    expect(pr1.meta.editability).toBeUndefined();
  });

  it('editability: override survives reclassification with new machine verdict', async () => {
    await storeClassifications(specId, FIRST);
    await setEditabilityOverride(PR1_ID, 'note');
    // Re-run the engine with a DIFFERENT machine verdict.
    await storeClassifications(specId, RECLASSIFIED);

    const pr1 = await readPr1(specId);
    // Effective value still honors the human override...
    expect(pr1.meta.editability?.value).toBe('note');
    expect(pr1.meta.editability?.override).toBe('note');
    // ...while the machine's why-chain reflects the NEW reclassify pass.
    expect(pr1.meta.editability?.confidence).toBe(0.4);
    expect(pr1.meta.editability?.evidence).toEqual([
      { rule: 'defaultEditability', detail: 'color cleared on second pass' },
    ]);
  });

  it('clearEditabilityOverride restores machine classification as effective', async () => {
    await storeClassifications(specId, FIRST);
    await setEditabilityOverride(PR1_ID, 'locked');
    expect((await readPr1(specId)).meta.editability?.value).toBe('locked');

    await clearEditabilityOverride(PR1_ID);
    const pr1 = await readPr1(specId);
    expect(pr1.meta.editability?.value).toBe('editable');
    expect(pr1.meta.editability?.override).toBeUndefined();
  });

  it('getSpecTree surfaces effective editability + evidence on the classified paragraph', async () => {
    await storeClassifications(specId, FIRST);
    const pr1 = await readPr1(specId);
    expect(pr1.meta.editability?.value).toBe('editable');
    expect(pr1.meta.editability?.evidence.length).toBeGreaterThan(0);
  });

  it('storeClassifications is spec-scoped — a nodeId from another spec writes nothing', async () => {
    // FIRST targets PR1_ID, which belongs to `specId`. Calling
    // storeClassifications with the SIBLING's spec id must update no rows: the
    // `AND spec_id = $spec` guard rejects the cross-spec nodeId.
    const siblingId = await seedSpec('99 00 02', {
      part: SIB_PART_ID,
      article: SIB_ARTICLE_ID,
      pr1: SIB_PR1_ID,
    });

    await storeClassifications(siblingId, FIRST); // FIRST.nodeId === PR1_ID (specId's node)

    // The original spec's paragraph stays unclassified (no cross-spec write)...
    expect((await readPr1(specId)).meta.editability).toBeUndefined();
    // ...and the sibling's own paragraph is also untouched (its id differs).
    expect((await readPr1(siblingId)).meta.editability).toBeUndefined();
  });

  it('a corrupt classification row surfaces as a loud DatabaseError, never a silent drop', async () => {
    // Write a malformed payload directly (bypassing the closed write schema) to
    // simulate engine drift / manual tampering; the read boundary must reject it.
    await pool.query(`UPDATE paragraphs SET classification = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ editability: 'editable', confidence: 5, evidence: [] }),
      PR1_ID,
    ]);
    await expect(getSpecTree(specId)).rejects.toThrow();
  });
});
