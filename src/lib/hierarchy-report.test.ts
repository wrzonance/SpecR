// src/lib/hierarchy-report.test.ts
import { describe, expect, it } from 'vitest';
import { buildHierarchyReport, PREVIEW_MAX } from './hierarchy-report.js';
import { HIERARCHY_REVIEW_THRESHOLD, summarizeHierarchy } from './hierarchy-summary.js';
import { renderMarkdown } from '../generator/index.js';
import type { SignalConflict, SpecNode, SpecNodeInference, SpecTree } from '../ast/index.js';

// A small tree with a scored Part → Article → Paragraph, an interleaved note
// (must not shift ordinals), and a second article. Inference present on the
// structural nodes so they are "scored".
//
// NOTE: the task brief's illustrative fixture used `type: 'paragraph'` for x1,
// but 'paragraph' is not a member of NodeType (NodeTypeSchema.parse('paragraph')
// throws — see src/ast/schemas.test.ts) and would crash nodeTypeToNormalizedIlvl.
// Using 'pr1' here instead — a real pr-tier type — keeps the fixture's intent
// (a scored, low-confidence paragraph one level under an article) meaningful.
function scoredTree(): SpecTree {
  const inf = (confidence: number) => ({
    confidence,
    signalUsed: 4 as const,
    agreed: [1 as const],
    evidence: ['e'],
  });
  return {
    section: '09 91 23',
    title: 'T',
    parts: [
      {
        id: 'p1',
        type: 'part',
        text: 'GENERAL',
        children: [
          { id: 'n1', type: 'note', text: 'editorial', children: [], meta: {} },
          {
            id: 'a1',
            type: 'article',
            text: 'SUMMARY',
            children: [
              {
                id: 'x1',
                type: 'pr1',
                text: 'Provide unit prices',
                children: [],
                meta: { inference: inf(0.28) },
              },
            ],
            meta: { inference: inf(0.9) },
          },
          {
            id: 'a2',
            type: 'article',
            text: 'REFERENCES',
            children: [],
            meta: { inference: inf(0.55) },
          },
        ],
        meta: { inference: inf(0.95) },
      },
    ],
  } as unknown as SpecTree; // shape-only fixture; cast is test-local (allowed)
}

describe('buildHierarchyReport — labels', () => {
  it('every ScoredParagraph.label matches the label renderMarkdown emits for that node', () => {
    const tree = scoredTree();
    const report = buildHierarchyReport(tree, 'arcat');
    const md = renderMarkdown(tree);
    for (const p of report.paragraphs) {
      // The rendered markdown must contain "<label> <text>" for each scored node.
      expect(md).toContain(`${p.label} ${p.preview}`);
    }
    // The interleaved note did not shift the article ordinals.
    const summary = report.paragraphs.find((p) => p.nodeId === 'a1');
    expect(summary?.label).toBe('1.1');
  });
});

// Shared, real (non-cast) fixture builders for the behavior tests below — mirrors
// hierarchy-summary.test.ts's node()/tree() style, with an optional `text` so the
// preview-truncation test can supply oversized text.
const inf = (confidence: number): SpecNodeInference => ({
  confidence,
  signalUsed: 5,
  agreed: [],
  evidence: ['e'],
});

const node = (
  id: string,
  type: SpecNode['type'],
  meta: SpecNode['meta'] = {},
  children: SpecNode[] = [],
  text = 't'
): SpecNode => ({ id, type, text, children, meta });

const tree = (parts: SpecNode[]): SpecTree => ({
  id: 'e0f1a2b3-0000-4000-8000-000000000001',
  section: '01 10 00',
  title: 'T',
  parts,
});

describe('buildHierarchyReport — ordering, counts, and edge cases', () => {
  it('all-scored, worst-first: paragraphs are ascending confidence, one entry per scored node', () => {
    const t = tree([
      node('p1', 'part', { inference: inf(0.9) }, [
        node('a1', 'article', { inference: inf(0.4) }),
        node('a2', 'article', { inference: inf(0.7) }),
        node('a3', 'article', { inference: inf(0.1) }),
      ]),
    ]);
    const report = buildHierarchyReport(t, 'unknown');
    expect(report.paragraphs).toHaveLength(4); // p1, a1, a2, a3
    const confidences = report.paragraphs.map((p) => p.confidence);
    expect(confidences).toEqual([...confidences].sort((x, y) => x - y));
    expect(confidences[0]).toBe(0.1);
  });

  it('counts and the below-threshold subset agree with summarizeHierarchy (independent implementations)', () => {
    const t = tree([
      node('p1', 'part', { inference: inf(0.8) }, [
        node('a1', 'article', { inference: inf(0.9) }, [
          node('x1', 'pr1', { inference: inf(0.2) }),
          node('x2', 'pr1', {}), // unscored — no inference recorded
        ]),
        node('a2', 'article', { vanish: true, inference: inf(0.99) }, [
          node('x3', 'pr1', { inference: inf(0.1) }),
        ]),
      ]),
    ]);
    const report = buildHierarchyReport(t, null);
    const summary = summarizeHierarchy(t, null);
    expect(report.counts).toEqual(summary.counts);
    expect(report.counts).toEqual({ scored: 3, unscored: 1, belowThreshold: 1 });
    const belowThreshold = report.paragraphs
      .filter((p) => p.confidence < HIERARCHY_REVIEW_THRESHOLD)
      .map((p) => ({ nodeId: p.nodeId, confidence: p.confidence }));
    const lowConfidence = summary.lowConfidence.map((e) => ({
      nodeId: e.nodeId,
      confidence: e.confidence,
    }));
    expect(belowThreshold).toEqual(lowConfidence);
  });

  it('vanish-exclusion: a vanish article and its children appear in no entry and are not counted', () => {
    const t = tree([
      node('p1', 'part', { inference: inf(0.9) }, [
        node('a1', 'article', { vanish: true, inference: inf(0.95) }, [
          node('x1', 'pr1', { inference: inf(0.05) }),
        ]),
      ]),
    ]);
    const report = buildHierarchyReport(t, 'unknown');
    expect(report.paragraphs.map((p) => p.nodeId)).toEqual(['p1']);
    expect(report.counts).toEqual({ scored: 1, unscored: 0, belowThreshold: 0 });
  });

  it('unscored/empty: no inference anywhere yields empty paragraphs and a populated unscoredReason', () => {
    const t = tree([node('p1', 'part', {})]);

    const ufgs = buildHierarchyReport(t, 'ufgs');
    expect(ufgs).toEqual({
      counts: { scored: 0, unscored: 1, belowThreshold: 0 },
      unscoredReason: summarizeHierarchy(t, 'ufgs').unscoredReason,
      paragraphs: [],
    });
    expect(ufgs.unscoredReason).toContain('explicit structure');

    const preProvenance = buildHierarchyReport(t, 'arcat');
    expect(preProvenance.unscoredReason).toContain('re-import');
    expect(preProvenance.unscoredReason).toBe(summarizeHierarchy(t, 'arcat').unscoredReason);
  });

  it('preview truncation: text longer than PREVIEW_MAX is trimmed and the entry still labels correctly', () => {
    const longText = 'x'.repeat(PREVIEW_MAX + 40);
    const t = tree([node('p1', 'part', { inference: inf(0.9) }, [], longText)]);
    const report = buildHierarchyReport(t, 'unknown');
    const entry = report.paragraphs.find((p) => p.nodeId === 'p1');
    expect(entry?.preview).toHaveLength(PREVIEW_MAX);
    expect(entry?.preview).toBe(longText.slice(0, PREVIEW_MAX));
    expect(entry?.label).toBe('PART 1 -');
  });

  it('conflicts: surfaced when present; the field is absent when not (exactOptionalPropertyTypes)', () => {
    const conflicts: SignalConflict[] = [{ signal: 2, reportedIlvl: 3, reportedNodeType: 'pr2' }];
    const t = tree([
      node('p1', 'part', { inference: inf(0.9), conflicts }, [
        node('a1', 'article', { inference: inf(0.5) }),
      ]),
    ]);
    const report = buildHierarchyReport(t, 'unknown');
    const withConflicts = report.paragraphs.find((p) => p.nodeId === 'p1');
    const withoutConflicts = report.paragraphs.find((p) => p.nodeId === 'a1');
    expect(withConflicts?.conflicts).toEqual(conflicts);
    expect(withoutConflicts).not.toHaveProperty('conflicts');
  });
});
