import { describe, it, expect } from 'vitest';
import { summarizeEditability, LOW_CONFIDENCE_THRESHOLD } from './onboarding-report.js';
import type { SpecTree, SpecNode } from '../ast/types.js';
import type { Editability } from '../ast/index.js';

function node(id: string, value: Editability, confidence: number): SpecNode {
  return {
    id,
    type: 'pr1',
    text: id,
    children: [],
    meta: {
      editability: {
        value,
        confidence,
        evidence: [{ rule: 'defaultEditability', fact: 'none' }],
      },
    },
  };
}

const tree: SpecTree = {
  id: 's1',
  section: '09 91 26',
  title: 'Painting',
  parts: [
    node('a', 'editable', 0.9),
    node('b', 'editable', 0.4), // low-confidence
    {
      id: 'p',
      type: 'part',
      text: 'PART 1',
      children: [node('c', 'locked', 0.95), node('d', 'note', 0.5)], // d low-confidence
      meta: {}, // structural, unclassified — skipped
    },
  ],
};

describe('summarizeEditability', () => {
  it('counts effective values across the whole tree and flags low-confidence nodes', () => {
    const summary = summarizeEditability(tree);
    expect(summary.counts).toEqual({ locked: 1, editable: 2, choice: 0, note: 1 });
    expect(summary.lowConfidence.map((e) => e.nodeId).sort((a, b) => a.localeCompare(b))).toEqual([
      'b',
      'd',
    ]);
    expect(summary.lowConfidence.every((e) => e.confidence < LOW_CONFIDENCE_THRESHOLD)).toBe(true);
  });

  it('returns all-zero counts and empty list for a tree with no classifications', () => {
    const bare: SpecTree = { id: 's', section: 'x', title: 'y', parts: [] };
    expect(summarizeEditability(bare)).toEqual({
      counts: { locked: 0, editable: 0, choice: 0, note: 0 },
      lowConfidence: [],
    });
  });
});
