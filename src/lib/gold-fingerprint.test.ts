// src/lib/gold-fingerprint.test.ts
import { describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  diffFingerprint,
  LOW_CONFIDENCE_BAND,
  type GoldFingerprint,
} from './gold-fingerprint.js';
import { HIERARCHY_REVIEW_THRESHOLD } from './hierarchy-summary.js';
import type { SpecNode, SpecNodeInference, SpecTree } from '../ast/index.js';

const inf = (confidence: number): SpecNodeInference => ({
  confidence,
  signalUsed: 4,
  agreed: [1],
  evidence: ['e'],
});

function node(
  id: string,
  type: SpecNode['type'],
  text: string,
  children: SpecNode[],
  meta: SpecNode['meta'] = {}
): SpecNode {
  return { id, type, text, children, meta };
}

// PART 1 GENERAL → { Article SUMMARY → pr1 (low 0.28); Article REFERENCES (review 0.55) },
// PART 2 PRODUCTS (high 0.95). An interleaved note must not change any count.
function sampleTree(): SpecTree {
  return {
    id: 't',
    section: '09 91 23',
    title: 'PAINTING',
    parts: [
      node(
        'p1',
        'part',
        'GENERAL',
        [
          node('nx', 'note', 'editorial', []),
          node(
            'a1',
            'article',
            'SUMMARY',
            [node('x1', 'pr1', 'Provide unit prices', [], { inference: inf(0.28) })],
            { inference: inf(0.9) }
          ),
          node('a2', 'article', 'REFERENCES', [], { inference: inf(0.55) }),
        ],
        { inference: inf(0.95) }
      ),
      node('p2', 'part', 'PRODUCTS', [], { inference: inf(0.95) }),
    ],
  };
}

describe('computeFingerprint', () => {
  it('captures section, visible part count, and per-part structural shape', () => {
    const fp = computeFingerprint(sampleTree(), []);
    expect(fp.section).toBe('09 91 23');
    expect(fp.parts).toBe(2);
    // PART 1: [2 articles, 1 pr1] → [2, 1]; PART 2: no descendants → [].
    expect(fp.partShape).toEqual([[2, 1], []]);
    expect(fp.maxDepth).toBe(2); // deepest normalized ilvl reached: pr1 = 2
  });

  it('buckets scored paragraphs into low/review/high confidence bands', () => {
    const fp = computeFingerprint(sampleTree(), []);
    // 0.28 < 0.3 → low; 0.55 in [0.3,0.6) → review; 0.9,0.95,0.95 ≥ 0.6 → high.
    expect(fp.confidenceBands).toEqual({ high: 3, review: 1, low: 1 });
    expect(LOW_CONFIDENCE_BAND).toBeLessThan(HIERARCHY_REVIEW_THRESHOLD);
  });

  it('is deterministic — the same tree yields an identical fingerprint', () => {
    expect(computeFingerprint(sampleTree(), [])).toEqual(computeFingerprint(sampleTree(), []));
  });

  it('excludes a vanished part and its subtree from parts/shape', () => {
    const t = sampleTree();
    const parts = [...t.parts];
    parts[1] = { ...parts[1]!, meta: { vanish: true } };
    const fp = computeFingerprint({ ...t, parts }, []);
    expect(fp.parts).toBe(1);
    expect(fp.partShape).toEqual([[2, 1]]);
  });

  it('yields the -1 maxDepth sentinel for a parts-less tree', () => {
    const fp = computeFingerprint({ ...sampleTree(), parts: [] }, []);
    expect(fp.maxDepth).toBe(-1);
    expect(fp.partShape).toEqual([]);
  });
});

describe('diffFingerprint', () => {
  const base = (): GoldFingerprint => computeFingerprint(sampleTree(), []);

  it('returns no deltas for identical fingerprints', () => {
    expect(diffFingerprint(base(), base())).toEqual([]);
  });

  it('flags a changed part count as a single delta', () => {
    const changed: GoldFingerprint = { ...base(), parts: 3 };
    const deltas = diffFingerprint(base(), changed);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.field).toBe('parts');
  });

  it('flags a band shift and a shape change independently', () => {
    const changed: GoldFingerprint = {
      ...base(),
      confidenceBands: { high: 2, review: 2, low: 1 },
      partShape: [[3, 1], []],
    };
    const fields = diffFingerprint(base(), changed)
      .map((d) => d.field)
      .sort((a, b) => a.localeCompare(b));
    expect(fields).toEqual(['confidenceBands', 'partShape']);
  });
});
