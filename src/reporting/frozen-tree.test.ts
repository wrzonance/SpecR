import { describe, it, expect } from 'vitest';
import { flattenSpecTree } from './frozen-tree.js';
import { computeStructuralKeys } from './structure.js';
import type { SpecNode, SpecNodeMeta, SpecTree } from '../ast/index.js';
import type { ComparisonParagraph } from './types.js';

function node(
  id: string,
  type: SpecNode['type'],
  text: string,
  children: readonly SpecNode[] = [],
  meta: SpecNodeMeta = {}
): SpecNode {
  return { id, type, text, children, meta };
}

function tree(parts: readonly SpecNode[]): SpecTree {
  return { id: 'spec-1', section: '09 91 26', title: 'Fixture', parts };
}

describe('flattenSpecTree', () => {
  it('is pure and deterministic: repeated calls on the same tree produce identical output without mutating the input', () => {
    const t = tree([node('part1', 'part', 'PART 1', [node('a1', 'article', 'ARTICLE', [])])]);
    const before = JSON.parse(JSON.stringify(t)) as SpecTree;

    const first = flattenSpecTree(t, 'spec-1');
    const second = flattenSpecTree(t, 'spec-1');

    expect(first).toEqual(second);
    expect(t).toEqual(before);
  });

  it("preserves live-loader vanish parity: an owner-removed (vanish, non-note) node and all its descendants are excluded, mirroring getComparisonParagraphs' recursive CTE", () => {
    const t = tree([
      node('part1', 'part', 'PART 1', [
        node('a1', 'article', 'KEPT', []),
        node(
          'a2',
          'article',
          'REMOVED',
          [node('c1', 'pr1', 'CHILD OF REMOVED — not itself vanish', [])],
          { vanish: true }
        ),
        node('a3', 'article', 'KEPT AFTER', []),
      ]),
    ]);

    const rows = flattenSpecTree(t, 'spec-1');

    expect(rows.map((r) => r.id)).toEqual(['part1', 'a1', 'a3']);
  });

  it('retains a vanish=true note — only non-note vanish nodes are owner-removed', () => {
    const t = tree([
      node('part1', 'part', 'PART 1', [node('n1', 'note', 'NOTE', [], { vanish: true })]),
    ]);

    const rows = flattenSpecTree(t, 'spec-1');

    expect(rows.map((r) => r.id)).toEqual(['part1', 'n1']);
  });

  it("flattenSpecTree's DFS-assigned position values preserve per-parent sibling order", () => {
    const t = tree([
      node('part1', 'part', 'PART 1', [
        node('a1', 'article', 'A1', [node('c1', 'pr1', 'C1', []), node('c2', 'pr1', 'C2', [])]),
        node('a2', 'article', 'A2', []),
      ]),
      node('part2', 'part', 'PART 2', []),
    ]);

    const rows = flattenSpecTree(t, 'spec-1');
    const positionOf = new Map(rows.map((r) => [r.id, r.position]));

    expect(positionOf.get('part1')).toBe(0);
    expect(positionOf.get('part2')).toBe(1);
    expect(positionOf.get('a1')).toBe(0);
    expect(positionOf.get('a2')).toBe(1);
    expect(positionOf.get('c1')).toBe(0);
    expect(positionOf.get('c2')).toBe(1);
  });

  it('renumbers positions densely over kept siblings only — a removed sibling never leaves a gap', () => {
    const t = tree([
      node('part1', 'part', 'PART 1', [
        node('a1', 'article', 'KEPT', []),
        node('a2', 'article', 'REMOVED', [], { vanish: true }),
        node('a3', 'article', 'KEPT AFTER', []),
      ]),
    ]);

    const rows = flattenSpecTree(t, 'spec-1');
    const positionOf = new Map(rows.map((r) => [r.id, r.position]));

    expect(positionOf.get('a1')).toBe(0);
    expect(positionOf.get('a3')).toBe(1);
  });

  it('maps every node to a full ComparisonParagraph row: specId stamped throughout, originParagraphId defaults to null, parentId reflects tree structure', () => {
    const t = tree([
      node('part1', 'part', 'PART 1', [
        node('a1', 'article', 'A1', [], {
          originParagraphId: '11111111-1111-4111-8111-111111111111',
        }),
      ]),
    ]);

    const rows = flattenSpecTree(t, 'spec-xyz');

    expect(rows).toEqual([
      {
        specId: 'spec-xyz',
        id: 'part1',
        originParagraphId: null,
        text: 'PART 1',
        position: 0,
        parentId: null,
        nodeType: 'part',
      },
      {
        specId: 'spec-xyz',
        id: 'a1',
        originParagraphId: '11111111-1111-4111-8111-111111111111',
        text: 'A1',
        position: 0,
        parentId: 'part1',
        nodeType: 'article',
      },
    ]);
  });

  it('// KNOWN AMBIGUITY: empty-text nodes pass through unfiltered — the schema boundary, not the flattener, is what keeps them out of a real frozen tree', () => {
    // In production, `validateTree` (revision-snapshot.ts) rejects any snapshot
    // candidate against `SpecNodeSchema` — `text` has `minLength(1)` — before a
    // tree can ever reach this function. The live loader (getComparisonParagraphs)
    // instead retains empty-text paragraphs BY DESIGN (ADR-047): they are real
    // rows with valid origin links and dropping them would be an untraceable hole
    // in the matrix. flattenSpecTree has no equivalent design choice to make —
    // the schema boundary already prevents the case for real frozen trees — so it
    // does not special-case an empty-text node: it is retained like any other row,
    // same as the live loader would retain it. Pinned here rather than left as an
    // unstated assumption.
    const t = tree([node('a1', 'article', '', [])]);

    const rows = flattenSpecTree(t, 'spec-1');

    expect(rows.map((r) => r.text)).toEqual(['']);
  });
});

// #392 review finding: this suite's `liveLoaderRows()` is a HAND-AUTHORED
// stand-in for `getComparisonParagraphs` (src/db/queries/reporting.ts), not
// the real query — so it only proves computeStructuralKeys is invariant to
// differing raw `position` conventions (1-based-with-gaps vs. flattenSpecTree's
// own 0-based DFS index), which is a property of the pure aligner alone
// (structure.ts: `byPositionThenId` keys on relative sibling ORDER, never the
// literal integers). It does NOT prove flattenSpecTree's DFS sibling order and
// getComparisonParagraphs'/buildNodeTree's sibling order actually agree for a
// real spec — that cross-loader half of the invariant is pinned separately,
// against the REAL loaders and a real frozen revision, by
// frozen-sources.integration.test.ts's "flattenSpecTree <-> live-loader
// parity — real loaders, same spec (#392 review)" suite. Keep both: this one
// is fast/DB-free and pins the aligner's position-convention invariance; the
// integration suite pins the thing this test's name might otherwise imply it
// already covers.
describe('flattenSpecTree <-> synthetic live-loader-shaped rows — computeStructuralKeys tolerates differing position conventions (#392 review)', () => {
  const SPEC_ID = 'spec-1';

  function liveRow(
    over: Partial<ComparisonParagraph> & Pick<ComparisonParagraph, 'id' | 'nodeType' | 'position'>
  ): ComparisonParagraph {
    return {
      specId: SPEC_ID,
      originParagraphId: null,
      text: 'x',
      parentId: null,
      ...over,
    };
  }

  // As `getComparisonParagraphs` would return it: 1-based per-parent
  // positions, with a gap at part1's position 2 (an owner-removed sibling
  // there was already excluded upstream by the CTE, same as production).
  function liveLoaderRows(): readonly ComparisonParagraph[] {
    return [
      liveRow({ id: 'part1', nodeType: 'part', position: 1 }),
      liveRow({ id: 'artA', nodeType: 'article', position: 1, parentId: 'part1' }),
      liveRow({ id: 'artB', nodeType: 'article', position: 3, parentId: 'part1' }),
      liveRow({ id: 'c1', nodeType: 'pr1', position: 1, parentId: 'artA' }),
      liveRow({ id: 'c2', nodeType: 'pr1', position: 2, parentId: 'artA' }),
      liveRow({ id: 'part2', nodeType: 'part', position: 2 }),
      liveRow({ id: 'artC', nodeType: 'article', position: 1, parentId: 'part2' }),
    ];
  }

  // The SAME logical tree, same node ids, expressed as the SpecTree a freeze
  // of this exact (unedited) spec would snapshot — flattenSpecTree recomputes
  // its own 0-based `position` from array order, never the integers above.
  function frozenTree(): SpecTree {
    return tree([
      node('part1', 'part', 'PART 1', [
        node('artA', 'article', 'ARTICLE A', [
          node('c1', 'pr1', 'Clause 1', []),
          node('c2', 'pr1', 'Clause 2', []),
        ]),
        node('artB', 'article', 'ARTICLE B', []),
      ]),
      node('part2', 'part', 'PART 2', [node('artC', 'article', 'ARTICLE C', [])]),
    ]);
  }

  it('produces identical node-id -> structural-address maps from both flatten paths', () => {
    const liveKeys = computeStructuralKeys(liveLoaderRows());
    const frozenRows = flattenSpecTree(frozenTree(), SPEC_ID);
    const frozenKeys = computeStructuralKeys(frozenRows);

    const sortedIds = (keys: ReadonlyMap<string, string>): readonly string[] =>
      [...keys.keys()].sort((a, b) => a.localeCompare(b));
    expect(sortedIds(frozenKeys)).toEqual(sortedIds(liveKeys));
    for (const [id, liveAddress] of liveKeys) {
      expect(frozenKeys.get(id)).toBe(liveAddress);
    }
  });
});
