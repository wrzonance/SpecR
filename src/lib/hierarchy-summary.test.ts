// src/lib/hierarchy-summary.test.ts
import { describe, expect, it } from 'vitest';
import { HIERARCHY_REVIEW_THRESHOLD, summarizeHierarchy } from './hierarchy-summary.js';
import type { SpecNode, SpecNodeInference, SpecTree } from '../ast/index.js';

const inf = (confidence: number): SpecNodeInference => ({
  confidence,
  signalUsed: 5,
  agreed: [],
  evidence: ['indentation won alone', 'no corroborating signal fired'],
});

const node = (
  id: string,
  type: SpecNode['type'],
  meta: SpecNode['meta'] = {},
  children: SpecNode[] = []
): SpecNode => ({ id, type, text: 't', children, meta });

const tree = (parts: SpecNode[]): SpecTree => ({
  id: 'e0f1a2b3-0000-4000-8000-000000000000',
  section: '01 10 00',
  title: 'T',
  parts,
});

describe('summarizeHierarchy', () => {
  it('buckets scored / unscored / belowThreshold and sorts lowConfidence worst-first', () => {
    const t = tree([
      node('p1', 'part', { inference: inf(0.95) }, [
        node('a1', 'article', { inference: inf(0.35) }),
        node('a2', 'article', { inference: inf(0.5) }),
        node('a3', 'article', {}), // unscored structural
        node('n1', 'note', {}), // non-structural — never counted
        node('c1', 'continuation', {}),
      ]),
    ]);
    const s = summarizeHierarchy(t, 'unknown');
    expect(s.counts).toEqual({ scored: 3, unscored: 1, belowThreshold: 2 });
    expect(s.lowConfidence.map((e) => e.nodeId)).toEqual(['a1', 'a2']); // ascending confidence
    expect(s.lowConfidence[0]).toMatchObject({ nodeType: 'article', ilvl: 1, confidence: 0.35 });
    expect(s.lowConfidence[0]?.evidence).toContain('indentation won alone');
  });

  it('vanish nodes are skipped entirely', () => {
    const t = tree([
      node('p1', 'part', { inference: inf(0.9) }, [node('a1', 'article', { vanish: true })]),
    ]);
    expect(summarizeHierarchy(t, 'unknown').counts).toEqual({
      scored: 1,
      unscored: 0,
      belowThreshold: 0,
    });
  });

  it('vanish: a soft-removed subtree is pruned — hidden descendants are not scored or flagged', () => {
    // Removal sets vanish on one node only (no cascade); the renderers suppress the
    // whole subtree, so a scored, low-confidence descendant under a removed parent
    // must NOT surface in the report (it no longer renders).
    const t = tree([
      node('p1', 'part', { inference: inf(0.9) }, [
        node('pr1', 'pr1', { vanish: true, inference: inf(0.9) }, [
          node('pr2', 'pr2', { inference: inf(0.2) }),
        ]),
      ]),
    ]);
    const s = summarizeHierarchy(t, 'unknown');
    expect(s.counts).toEqual({ scored: 1, unscored: 0, belowThreshold: 0 });
    expect(s.lowConfidence).toEqual([]);
  });

  it('unscoredReason absent when everything is scored', () => {
    const t = tree([node('p1', 'part', { inference: inf(0.9) })]);
    expect(summarizeHierarchy(t, 'unknown').unscoredReason).toBeUndefined();
  });

  it('SEC source reads as explicit structure, never suspect', () => {
    const t = tree([node('p1', 'part', {})]);
    const s = summarizeHierarchy(t, 'ufgs');
    expect(s.counts).toEqual({ scored: 0, unscored: 1, belowThreshold: 0 });
    expect(s.unscoredReason).toContain('explicit structure');
    expect(s.unscoredReason).not.toMatch(/re-import/);
  });

  it('unscored DOCX carries the re-import upgrade path', () => {
    const t = tree([node('p1', 'part', {})]);
    expect(summarizeHierarchy(t, 'unknown').unscoredReason).toContain('re-import');
  });

  it('threshold boundary: exactly 0.6 is NOT low-confidence', () => {
    const t = tree([node('p1', 'part', { inference: inf(HIERARCHY_REVIEW_THRESHOLD) })]);
    expect(summarizeHierarchy(t, 'unknown').counts.belowThreshold).toBe(0);
  });

  it('empty tree → all-zero counts, empty list', () => {
    expect(summarizeHierarchy(tree([]), 'unknown')).toEqual({
      counts: { scored: 0, unscored: 0, belowThreshold: 0 },
      lowConfidence: [],
    });
  });
});
