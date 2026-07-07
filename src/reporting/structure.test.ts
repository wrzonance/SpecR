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

  it('// KNOWN AMBIGUITY: a node whose parentId is absent from rows is addressed as a root — colliding with a real root of the same (nodeType, ordinal)', () => {
    // The loader's parent self-FK guarantees a parent row is always loaded, so a
    // dangling parentId cannot occur in production. For this malformed input the
    // function does NOT throw: with the parent unresolved it emits only the node's
    // own segment — i.e. addresses it as a root. A real root of the same nodeType
    // then shares that address. Accepted because it is unreachable via the loader.
    const rows = [
      p({ id: 'realRoot', nodeType: 'part', parentId: null, position: 0 }),
      p({ id: 'orphan', nodeType: 'part', parentId: 'ghost', position: 0 }),
    ];
    const keys = computeStructuralKeys(rows);
    expect(keys.get('orphan')).toBe('part:0'); // segment only — treated as a root
    expect(keys.get('realRoot')).toBe('part:0'); // real root — identical address
    expect(keys.get('orphan')).toBe(keys.get('realRoot')); // the accepted collision
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
