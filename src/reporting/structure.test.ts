import { describe, it, expect } from 'vitest';
import { computeStructuralKeys } from './structure.js';
import type { ComparisonParagraph } from './types.js';

function p(
  over: Partial<ComparisonParagraph> & Pick<ComparisonParagraph, 'id' | 'nodeType'>
): ComparisonParagraph {
  return { specId: 's', originParagraphId: null, text: '', position: 0, parentId: null, ...over };
}

describe('computeStructuralKeys', () => {
  it('addresses a two-part tree by (nodeType, same-type ordinal) root-to-node path', () => {
    const rows = [
      p({ id: 'part1', nodeType: 'part', position: 0 }),
      p({ id: 'a1', nodeType: 'article', parentId: 'part1', position: 0 }),
      p({ id: 'a2', nodeType: 'article', parentId: 'part1', position: 1 }),
      p({ id: 'c1', nodeType: 'pr1', parentId: 'a2', position: 0 }),
      p({ id: 'part2', nodeType: 'part', position: 1 }),
    ];
    const keys = computeStructuralKeys(rows);
    expect(keys.get('part1')).toBe('part:0');
    expect(keys.get('a1')).toBe('part:0|article:0');
    expect(keys.get('a2')).toBe('part:0|article:1');
    expect(keys.get('c1')).toBe('part:0|article:1|pr1:0');
    expect(keys.get('part2')).toBe('part:1');
  });

  it('scopes ordinal per nodeType: interleaved notes do not shift numbered siblings', () => {
    const rows = [
      p({ id: 'part1', nodeType: 'part', position: 0 }),
      p({ id: 'a1', nodeType: 'article', parentId: 'part1', position: 0 }),
      p({ id: 'n1', nodeType: 'note', parentId: 'part1', position: 1 }),
      p({ id: 'a2', nodeType: 'article', parentId: 'part1', position: 2 }),
      p({ id: 'n2', nodeType: 'note', parentId: 'part1', position: 3 }),
    ];
    const keys = computeStructuralKeys(rows);
    expect(keys.get('a1')).toBe('part:0|article:0');
    expect(keys.get('a2')).toBe('part:0|article:1'); // note between them didn't bump it
    expect(keys.get('n1')).toBe('part:0|note:0');
    expect(keys.get('n2')).toBe('part:0|note:1'); // notes get distinct, collision-free slots
  });

  it('is deterministic regardless of input row order (sorts by position,id)', () => {
    const base = [
      p({ id: 'part1', nodeType: 'part', position: 0 }),
      p({ id: 'a1', nodeType: 'article', parentId: 'part1', position: 0 }),
      p({ id: 'a2', nodeType: 'article', parentId: 'part1', position: 1 }),
    ];
    const shuffled = [base[2], base[0], base[1]].filter(
      (x): x is ComparisonParagraph => x !== undefined
    );
    expect(computeStructuralKeys(shuffled)).toEqual(computeStructuralKeys(base));
  });

  it('assigns a distinct address to every node within a source (no intra-source collisions)', () => {
    const rows = [
      p({ id: 'part1', nodeType: 'part', position: 0 }),
      p({ id: 'a1', nodeType: 'article', parentId: 'part1', position: 0 }),
      p({ id: 'a2', nodeType: 'article', parentId: 'part1', position: 1 }),
    ];
    const keys = computeStructuralKeys(rows);
    expect(new Set(keys.values()).size).toBe(keys.size);
  });
});
