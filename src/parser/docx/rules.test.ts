import { describe, it, expect } from 'vitest';
import { ilvlToNodeType, SECTION_REF_RULES, ARCAT_ILVL_MAP, MASTERSPEC_ILVL_MAP } from './rules.js';

describe('ilvlToNodeType', () => {
  describe('ARCAT-style (articleIlvl=1)', () => {
    it('maps ilvl 0 to part', () => expect(ilvlToNodeType(0, 1)).toBe('part'));
    it('maps ilvl 1 to article', () => expect(ilvlToNodeType(1, 1)).toBe('article'));
    it('maps ilvl 2 to pr1', () => expect(ilvlToNodeType(2, 1)).toBe('pr1'));
    it('maps ilvl 3 to pr2', () => expect(ilvlToNodeType(3, 1)).toBe('pr2'));
    it('maps ilvl 4 to pr3', () => expect(ilvlToNodeType(4, 1)).toBe('pr3'));
    it('maps ilvl 5 to pr4', () => expect(ilvlToNodeType(5, 1)).toBe('pr4'));
    it('maps ilvl 6 to pr5', () => expect(ilvlToNodeType(6, 1)).toBe('pr5'));
    it('maps ilvl 7+ to continuation', () => expect(ilvlToNodeType(7, 1)).toBe('continuation'));
  });

  describe('MASTERSPEC-style (articleIlvl=3)', () => {
    it('maps ilvl 0 to part', () => expect(ilvlToNodeType(0, 3)).toBe('part'));
    it('maps ilvl 1 to continuation (reserved Schedule level)', () =>
      expect(ilvlToNodeType(1, 3)).toBe('continuation'));
    it('maps ilvl 2 to continuation (reserved PDS level)', () =>
      expect(ilvlToNodeType(2, 3)).toBe('continuation'));
    it('maps ilvl 3 to article', () => expect(ilvlToNodeType(3, 3)).toBe('article'));
    it('maps ilvl 4 to pr1', () => expect(ilvlToNodeType(4, 3)).toBe('pr1'));
    it('maps ilvl 5 to pr2', () => expect(ilvlToNodeType(5, 3)).toBe('pr2'));
    it('maps ilvl 8 to pr5', () => expect(ilvlToNodeType(8, 3)).toBe('pr5'));
    it('maps ilvl 9+ to continuation', () => expect(ilvlToNodeType(9, 3)).toBe('continuation'));
  });
});

describe('SECTION_REF_RULES — structure', () => {
  it('each rule has id, description, pattern, targetType, examples', () => {
    for (const rule of SECTION_REF_RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(['section', 'standard']).toContain(rule.targetType);
      expect(rule.examples.length).toBeGreaterThan(0);
    }
  });

  it('csi-section-keyword matches standard CSI references', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword');
    expect(rule).toBeDefined();
    const fresh = () => new RegExp(rule!.pattern.source, 'i');
    expect(fresh().test('See Section 09 91 00')).toBe(true);
    expect(fresh().test('Section 27 21 00 applies')).toBe(true);
  });

  it('csi-section-keyword does not match malformed section numbers', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword')!;
    const fresh = () => new RegExp(rule.pattern.source, 'i');
    expect(fresh().test('Section 9 91 00')).toBe(false); // missing leading zero
    expect(fresh().test('Section 091 00')).toBe(false); // wrong grouping
  });
});

describe('ilvl maps — documentation completeness', () => {
  it('ARCAT_ILVL_MAP covers part through pr5', () => {
    const types = ARCAT_ILVL_MAP.map((r) => r.nodeType);
    expect(types).toContain('part');
    expect(types).toContain('article');
    expect(types).toContain('pr5');
  });

  it('MASTERSPEC_ILVL_MAP article rule has description mentioning reserved levels', () => {
    const articleRule = MASTERSPEC_ILVL_MAP.find((r) => r.nodeType === 'article');
    expect(articleRule?.description.toLowerCase()).toContain('reserved');
  });

  it('all signal rules have non-empty description', () => {
    for (const rule of [...ARCAT_ILVL_MAP, ...MASTERSPEC_ILVL_MAP]) {
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });
});
