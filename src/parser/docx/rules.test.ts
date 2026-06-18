import { describe, it, expect } from 'vitest';
import { ilvlToNodeType, ARCAT_ILVL_MAP, CPI_ILVL_MAP } from './rules.js';

describe('ilvlToNodeType', () => {
  describe('ARCAT-style (articleIlvl=1)', () => {
    it('maps ilvl 0 to part', () => expect(ilvlToNodeType(0, 1)).toBe('part'));
    it('maps ilvl 1 to article', () => expect(ilvlToNodeType(1, 1)).toBe('article'));
    it('maps ilvl 2 to pr1', () => expect(ilvlToNodeType(2, 1)).toBe('pr1'));
    it('maps ilvl 3 to pr2', () => expect(ilvlToNodeType(3, 1)).toBe('pr2'));
    it('maps ilvl 4 to pr3', () => expect(ilvlToNodeType(4, 1)).toBe('pr3'));
    it('maps ilvl 5 to pr4', () => expect(ilvlToNodeType(5, 1)).toBe('pr4'));
    it('maps ilvl 6 to pr5', () => expect(ilvlToNodeType(6, 1)).toBe('pr5'));
    it('maps ilvl 7 to pr6', () => expect(ilvlToNodeType(7, 1)).toBe('pr6'));
    it('maps ilvl 8 to pr7', () => expect(ilvlToNodeType(8, 1)).toBe('pr7'));
    it('maps ilvl 9+ to continuation', () => expect(ilvlToNodeType(9, 1)).toBe('continuation'));
  });

  describe('CPI-style (articleIlvl=3)', () => {
    it('maps ilvl 0 to part', () => expect(ilvlToNodeType(0, 3)).toBe('part'));
    it('maps ilvl 1 to continuation (reserved Schedule level)', () =>
      expect(ilvlToNodeType(1, 3)).toBe('continuation'));
    it('maps ilvl 2 to continuation (reserved PDS level)', () =>
      expect(ilvlToNodeType(2, 3)).toBe('continuation'));
    it('maps ilvl 3 to article', () => expect(ilvlToNodeType(3, 3)).toBe('article'));
    it('maps ilvl 4 to pr1', () => expect(ilvlToNodeType(4, 3)).toBe('pr1'));
    it('maps ilvl 5 to pr2', () => expect(ilvlToNodeType(5, 3)).toBe('pr2'));
    it('maps ilvl 8 to pr5', () => expect(ilvlToNodeType(8, 3)).toBe('pr5'));
    it('maps ilvl 9 to pr6', () => expect(ilvlToNodeType(9, 3)).toBe('pr6'));
    it('maps ilvl 10 to pr7', () => expect(ilvlToNodeType(10, 3)).toBe('pr7'));
    it('maps ilvl 11+ to continuation', () => expect(ilvlToNodeType(11, 3)).toBe('continuation'));
  });

  // KNOWN AMBIGUITY: Word numbering caps at nine levels, so the AST sequence ends
  // at pr7. DOCX ilvls past the sequence all map to 'continuation' — distinct
  // source depths collapse to one type, so the original ilvl is not recoverable
  // on round-trip. ADR-027 records this as deliberately lossy.
  describe('KNOWN AMBIGUITY: ilvls beyond pr7 collapse to continuation (lossy)', () => {
    it('ARCAT-style: ilvl 9, 10, 11 all collapse to continuation', () => {
      expect(ilvlToNodeType(9, 1)).toBe('continuation');
      expect(ilvlToNodeType(10, 1)).toBe('continuation');
      expect(ilvlToNodeType(11, 1)).toBe('continuation');
    });
  });
});

describe('ilvl maps — documentation completeness', () => {
  it('ARCAT_ILVL_MAP covers part through pr7', () => {
    const types = ARCAT_ILVL_MAP.map((r) => r.nodeType);
    expect(types).toContain('part');
    expect(types).toContain('article');
    expect(types).toContain('pr7');
  });

  it('CPI_ILVL_MAP article rule has description mentioning reserved levels', () => {
    const articleRule = CPI_ILVL_MAP.find((r) => r.nodeType === 'article');
    expect(articleRule?.description.toLowerCase()).toContain('reserved');
  });

  it('all signal rules have non-empty description', () => {
    for (const rule of [...ARCAT_ILVL_MAP, ...CPI_ILVL_MAP]) {
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });
});
