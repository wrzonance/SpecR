import { describe, it, expect } from 'vitest';
import { alignTrees, projectBaseline } from './align.js';
import { ReportingError } from './error.js';
import type { AlignSource, ComparisonParagraph, ComparisonMatrix } from './types.js';

// Two projects cloned from a shared master program. Master paragraphs A, B, C.
// P1 is a faithful clone; P2 modifies B and adds a NULL-origin paragraph X.
const MA = 'aaaaaaaa-0000-4000-8000-000000000001';
const MB = 'aaaaaaaa-0000-4000-8000-000000000002';
const MC = 'aaaaaaaa-0000-4000-8000-000000000003';

function para(
  over: Partial<ComparisonParagraph> & Pick<ComparisonParagraph, 'specId' | 'id' | 'text'>
): ComparisonParagraph {
  return {
    originParagraphId: null,
    position: 0,
    parentId: null,
    nodeType: 'paragraph',
    ...over,
  };
}

function p1(): AlignSource {
  return {
    column: { specId: 'p1', section: '07 21 00', title: 'Thermal' },
    rows: [
      para({ specId: 'p1', id: 'p1-a', text: 'Alpha', originParagraphId: MA, position: 0 }),
      para({ specId: 'p1', id: 'p1-b', text: 'Bravo', originParagraphId: MB, position: 1 }),
      para({ specId: 'p1', id: 'p1-c', text: 'Charlie', originParagraphId: MC, position: 2 }),
    ],
  };
}

function p2(): AlignSource {
  return {
    column: { specId: 'p2', section: '07 21 00', title: 'Thermal' },
    rows: [
      para({ specId: 'p2', id: 'p2-a', text: 'Alpha', originParagraphId: MA, position: 0 }),
      para({ specId: 'p2', id: 'p2-b', text: 'Bravo EDITED', originParagraphId: MB, position: 1 }),
      para({ specId: 'p2', id: 'p2-c', text: 'Charlie', originParagraphId: MC, position: 2 }),
      // Added after cloning → NULL origin → only-in-P2.
      para({ specId: 'p2', id: 'p2-x', text: 'Extra', originParagraphId: null, position: 3 }),
    ],
  };
}

describe('alignTrees', () => {
  it('alignTrees: identical inputs yield byte-identical matrix (determinism)', () => {
    const run1 = alignTrees([p1(), p2()]);
    const run2 = alignTrees([p1(), p2()]);
    expect(run1).toEqual(run2);

    // Exact ordered rows: MA, MB, MC (first-occurrence across P1), then P2's NULL-origin X.
    expect(run1.matrix.rows.map((r) => r.originId)).toEqual([MA, MB, MC, 'p2-x']);
    expect(run1.matrix.columns.map((c) => c.specId)).toEqual(['p1', 'p2']);
  });

  it('grounding: every present cell copies a real spec + paragraph UUID + verbatim text', () => {
    const sources = [p1(), p2()];
    const { matrix } = alignTrees(sources);
    const rowById = indexRows(sources);
    for (const row of matrix.rows) {
      row.cells.forEach((cell, ci) => {
        if (!cell.present) return;
        const src = sources[ci];
        expect(src).toBeDefined();
        const origin = src?.column.specId ?? '';
        expect(cell.specId).toBe(origin);
        // paragraphUuid exists in that source's rows, and text strictly equals it.
        const found = rowById.get(`${origin}:${cell.paragraphUuid}`);
        expect(found).toBeDefined();
        expect(cell.text).toBe(found?.text);
      });
    }
  });

  it('only-in-X: a NULL-origin row is keyed on its own id and present only in its column', () => {
    const { matrix } = alignTrees([p1(), p2()]);
    const xRow = matrix.rows.find((r) => r.originId === 'p2-x');
    expect(xRow).toBeDefined();
    expect(xRow?.cells[0]).toEqual({ present: false }); // absent in P1
    expect(xRow?.cells[1]).toEqual({
      present: true,
      specId: 'p2',
      paragraphUuid: 'p2-x',
      text: 'Extra',
    });
  });

  it('// KNOWN AMBIGUITY: two rows in one source share an origin — first by (position,id) wins', () => {
    const collide: AlignSource = {
      column: { specId: 'p3', section: '07 21 00', title: 'x' },
      rows: [
        para({ specId: 'p3', id: 'p3-first', text: 'First', originParagraphId: MA, position: 0 }),
        para({ specId: 'p3', id: 'p3-second', text: 'Second', originParagraphId: MA, position: 1 }),
      ],
    };
    const { matrix } = alignTrees([collide], { alignment: 'origin' });
    // Single aligned row keyed MA; the winner is the first (position 0).
    expect(matrix.rows).toHaveLength(1);
    const cell = matrix.rows[0]?.cells[0];
    expect(cell).toEqual({ present: true, specId: 'p3', paragraphUuid: 'p3-first', text: 'First' });
  });

  it('origin-agnostic to hierarchy: differing nodeType/position still align on origin (CPI ilvl offset)', () => {
    // Same logical article, different reserved ilvl → different position/nodeType,
    // but the shared origin keeps them aligned.
    const arcat: AlignSource = {
      column: { specId: 'arcat', section: '07 21 00', title: 'x' },
      rows: [
        para({
          specId: 'arcat',
          id: 'arcat-a',
          text: 'Same',
          originParagraphId: MA,
          position: 1,
          nodeType: 'article',
        }),
      ],
    };
    const cpi: AlignSource = {
      column: { specId: 'cpi', section: '07 21 00', title: 'x' },
      rows: [
        para({
          specId: 'cpi',
          id: 'cpi-a',
          text: 'Same',
          originParagraphId: MA,
          position: 3,
          nodeType: 'paragraph',
        }),
      ],
    };
    const { matrix } = alignTrees([arcat, cpi]);
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0]?.cells.every((c) => c.present)).toBe(true);
  });
});

describe('projectBaseline', () => {
  it('projects baseline / unchanged / added / removed / modified / absent correctly', () => {
    const sources = [p1(), p2()];
    const { matrix, baseline } = alignTrees(sources, { baseline: 'p1' });
    expect(baseline).toBeDefined();
    const lens = baseline ?? projectBaseline(matrix, 'p1');

    const stateFor = (originId: string): readonly string[] =>
      lens.rows.find((r) => r.originId === originId)?.states ?? [];

    // Baseline column is always 'baseline'.
    expect(stateFor(MA)[0]).toBe('baseline');
    // A unchanged (Alpha == Alpha) in P2.
    expect(stateFor(MA)[1]).toBe('unchanged');
    // B modified (Bravo != Bravo EDITED) in P2.
    expect(stateFor(MB)[1]).toBe('modified');
    // C unchanged in P2.
    expect(stateFor(MC)[1]).toBe('unchanged');
    // X added in P2 (absent in the p1 baseline). The baseline column itself is
    // always tagged 'baseline', even where the baseline row is absent.
    expect(stateFor('p2-x')[0]).toBe('baseline');
    expect(stateFor('p2-x')[1]).toBe('added');
  });

  it('projection introduces no new specIds or UUIDs', () => {
    const { matrix, baseline } = alignTrees([p1(), p2()], { baseline: 'p1' });
    const knownSpecIds = new Set(matrix.columns.map((c) => c.specId));
    const knownOrigins = new Set(matrix.rows.map((r) => r.originId));
    for (const row of baseline?.rows ?? []) {
      expect(knownOrigins.has(row.originId)).toBe(true);
    }
    expect(baseline?.specId).toBeDefined();
    expect(knownSpecIds.has(baseline?.specId ?? '')).toBe(true);
  });

  it('throws ReportingError when the baseline is not a column', () => {
    const { matrix } = alignTrees([p1(), p2()]);
    expect(() => projectBaseline(matrix, 'nope')).toThrow(ReportingError);
  });
});

describe('alignTrees — alignment mode', () => {
  // Two independently-ingested specs: no shared origin (all NULL → key = own id),
  // identical structure (PART/article/pr1).
  function indieSource(
    specId: string,
    texts: readonly string[],
    section = '07 21 00'
  ): AlignSource {
    const partId = `${specId}-part`;
    const artId = `${specId}-art`;
    return {
      column: { specId, section, title: 'T' },
      rows: [
        para({ specId, id: partId, text: 'PART 1', nodeType: 'part', position: 0 }),
        para({
          specId,
          id: artId,
          text: 'SUMMARY',
          nodeType: 'article',
          parentId: partId,
          position: 0,
        }),
        ...texts.map((t, i) =>
          para({
            specId,
            id: `${specId}-c${i}`,
            text: t,
            nodeType: 'pr1',
            parentId: artId,
            position: i,
          })
        ),
      ],
    };
  }

  it('auto falls back to structure when sources share no cross-source origin key', () => {
    const a = indieSource('a', ['Alpha', 'Bravo']);
    const b = indieSource('b', ['Alpha', 'Bravo EDITED']);
    const { matrix, alignedBy } = alignTrees([a, b]);
    expect(alignedBy).toBe('structure');
    // Every row aligns both columns (identical structure): part, article, 2 pr1.
    expect(matrix.rows).toHaveLength(4);
    expect(matrix.rows.every((r) => r.cells[0]?.present && r.cells[1]?.present)).toBe(true);
    const bravo = matrix.rows.find((r) => r.cells[0]?.present && r.cells[0].text === 'Bravo');
    expect(bravo?.cells[1]).toMatchObject({ present: true, text: 'Bravo EDITED' });
  });

  it('auto uses origin when sources share a cross-source origin key (shared master)', () => {
    const { alignedBy } = alignTrees([p1(), p2()]);
    expect(alignedBy).toBe('origin');
  });

  it('auto stays on origin for different-section sources — coincidental addresses are not paired', () => {
    // No shared origin AND different CSI sections. Both trees have a part:0|article:0
    // address, but 07 21 00 and 09 91 00 are unrelated — pairing them would fabricate
    // identical/modified rows. auto must NOT fall back to structure here (ADR-053).
    const a = indieSource('a', ['Alpha'], '07 21 00');
    const b = indieSource('b', ['Beta'], '09 91 00');
    const { matrix, alignedBy } = alignTrees([a, b]);
    expect(alignedBy).toBe('origin');
    // Nothing aligns across unrelated sections: every row is present in exactly one column.
    expect(matrix.rows.every((r) => r.cells.filter((c) => c.present).length === 1)).toBe(true);
  });

  it('explicit alignment: "structure" still applies across different sections (caller opted in)', () => {
    const a = indieSource('a', ['Alpha'], '07 21 00');
    const b = indieSource('b', ['Beta'], '09 91 00');
    const { alignedBy } = alignTrees([a, b], { alignment: 'structure' });
    expect(alignedBy).toBe('structure'); // the section gate only guards the auto fallback
  });

  it('explicit alignment: "origin" forces origin even for independently-ingested specs', () => {
    const a = indieSource('a', ['Alpha']);
    const b = indieSource('b', ['Alpha']);
    const { matrix, alignedBy } = alignTrees([a, b], { alignment: 'origin' });
    expect(alignedBy).toBe('origin');
    // No shared origin → nothing aligns → every row present in exactly one column.
    expect(matrix.rows.every((r) => r.cells.filter((c) => c.present).length === 1)).toBe(true);
  });

  it('explicit alignment: "structure" forces structure even for shared-master clones', () => {
    const { alignedBy } = alignTrees([p1(), p2()], { alignment: 'structure' });
    expect(alignedBy).toBe('structure');
  });

  it('structure alignment is deterministic: run1 deep-equals run2', () => {
    const mk = (): readonly AlignSource[] => [
      indieSource('a', ['x', 'y']),
      indieSource('b', ['x', 'z']),
    ];
    expect(alignTrees(mk(), { alignment: 'structure' })).toEqual(
      alignTrees(mk(), { alignment: 'structure' })
    );
  });

  it('// KNOWN AMBIGUITY: an inserted sibling shifts downstream ordinals — structural alignment mispairs by position', () => {
    // b inserts a new first clause; structure keys on ordinal, so b-c0(New) aligns
    // with a-c0(Alpha), a-c1(Bravo) with b-c1(Alpha), etc. This ordinal-shift
    // misalignment is accepted for this slice (ADR-053) — assert the accepted shape.
    const a = indieSource('a', ['Alpha', 'Bravo']);
    const b = indieSource('b', ['New', 'Alpha', 'Bravo']);
    const { matrix } = alignTrees([a, b], { alignment: 'structure' });
    const first = matrix.rows.find((r) => r.cells[0]?.present && r.cells[0].text === 'Alpha');
    // 'Alpha' (a, ordinal 0) pairs with b's ordinal-0 clause 'New', not b's 'Alpha'.
    expect(first?.cells[1]).toMatchObject({ present: true, text: 'New' });
  });
});

function indexRows(sources: readonly AlignSource[]): Map<string, ComparisonParagraph> {
  const map = new Map<string, ComparisonParagraph>();
  for (const s of sources) {
    for (const r of s.rows) map.set(`${s.column.specId}:${r.id}`, r);
  }
  return map;
}

// Type-only guard: ComparisonMatrix shape is exercised above.
export type _Matrix = ComparisonMatrix;
