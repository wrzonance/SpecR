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

  it('sums normalized real-content characters per visible part (contentChars)', () => {
    const fp = computeFingerprint(sampleTree(), []);
    // PART 1: 'GENERAL'(7)+'SUMMARY'(7)+'Provide unit prices'(19)+'REFERENCES'(10)=43;
    //   the 'editorial' note is excluded. PART 2: 'PRODUCTS'(8).
    expect(fp.contentChars).toEqual([43, 8]);
  });

  it('excludes note text from contentChars regardless of note size', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    const children = p1.children.map((c) =>
      c.type === 'note' ? { ...c, text: 'x'.repeat(500) } : c
    );
    const fp = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    expect(fp.contentChars[0]).toBe(43);
  });

  it('excludes a vanished subtree from contentChars', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    // Vanish the SUMMARY article: removes 'SUMMARY'(7) + 'Provide unit prices'(19) = 26.
    const children = p1.children.map((c) =>
      c.id === 'a1' ? { ...c, meta: { ...c.meta, vanish: true } } : c
    );
    const fp = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    expect(fp.contentChars[0]).toBe(17); // 'GENERAL'(7) + 'REFERENCES'(10)
  });

  it('counts continuation body text as real content', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    const a1 = p1.children.find((c) => c.id === 'a1')!;
    const a1cont = {
      ...a1,
      children: [...a1.children, node('c1', 'continuation', 'and more', [])],
    };
    const children = p1.children.map((c) => (c.id === 'a1' ? a1cont : c));
    const fp = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    expect(fp.contentChars[0]).toBe(51); // 43 + 'and more'(8)
  });

  it('is immune to whitespace jitter in real-content text', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    const a1 = p1.children.find((c) => c.id === 'a1')!;
    const jittered = {
      ...a1,
      children: [{ ...a1.children[0]!, text: '  Provide   unit\tprices  ' }],
    };
    const children = p1.children.map((c) => (c.id === 'a1' ? jittered : c));
    const fp = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    expect(fp.contentChars).toEqual([43, 8]);
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

  it('flags text loss as a contentChars delta while structure stays quiet', () => {
    const t = sampleTree();
    const p1 = t.parts[0]!;
    const a1 = p1.children.find((c) => c.id === 'a1')!;
    // Truncate the pr1 body (19 → 7); the node survives at the same level.
    const truncated = { ...a1, children: [{ ...a1.children[0]!, text: 'Provide' }] };
    const children = p1.children.map((c) => (c.id === 'a1' ? truncated : c));
    const actual = computeFingerprint({ ...t, parts: [{ ...p1, children }, t.parts[1]!] }, []);
    const fields = diffFingerprint(base(), actual).map((d) => d.field);
    expect(fields).toContain('contentChars'); // the loss is caught
    expect(fields).not.toContain('partShape'); // structure unchanged
    expect(fields).not.toContain('parts');
  });
});
