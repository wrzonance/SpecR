import { describe, expect, it } from 'vitest';
import { NODE_TYPES_BY_NORMALIZED_ILVL, nodeTypeToNormalizedIlvl } from './normalized-ilvl.js';

describe('nodeTypeToNormalizedIlvl', () => {
  it('maps every structural type to its canonical ilvl, round-tripping the by-ilvl list', () => {
    NODE_TYPES_BY_NORMALIZED_ILVL.forEach((nodeType, ilvl) => {
      expect(nodeTypeToNormalizedIlvl(nodeType)).toBe(ilvl);
    });
  });

  it('throws on a non-structural node type instead of silently aliasing it to part (ilvl 0)', () => {
    expect(() => nodeTypeToNormalizedIlvl('note')).toThrow(/no normalized ilvl/);
    expect(() => nodeTypeToNormalizedIlvl('continuation')).toThrow(/no normalized ilvl/);
  });
});
