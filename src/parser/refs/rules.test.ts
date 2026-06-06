import { describe, it, expect } from 'vitest';
import { SECTION_REF_RULES, STANDARD_ORG_PATTERNS, buildStandardRefRules } from './rules.js';

describe('SECTION_REF_RULES', () => {
  it('csi-section-keyword: each example string matches the pattern', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword');
    expect(rule).toBeDefined();
    for (const example of rule!.examples) {
      const fresh = new RegExp(rule!.pattern.source, rule!.pattern.flags);
      expect(fresh.test(example)).toBe(true);
    }
  });

  it('csi-section-keyword: rejects malformed section numbers', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword')!;
    const fresh = (): RegExp => new RegExp(rule.pattern.source, rule.pattern.flags);
    expect(fresh().test('Section 9 91 00')).toBe(false); // missing leading zero
    expect(fresh().test('Section 091 00')).toBe(false); // wrong grouping
  });

  it('every section rule has id, description, pattern, targetType=section, examples', () => {
    for (const rule of SECTION_REF_RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(rule.targetType).toBe('section');
      expect(rule.examples.length).toBeGreaterThan(0);
    }
  });

  it('csi-section-keyword: captures dotted suffix — Section 26 00 13.10 not truncated to base', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword')!;
    const fresh = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
    expect(fresh.exec('See Section 26 00 13.10 for switchgear')?.[1]).toBe('26 00 13.10');
  });

  it('csi-section-keyword: captures agency suffix — Section 01 32 01.00 10', () => {
    const rule = SECTION_REF_RULES.find((r) => r.id === 'csi-section-keyword')!;
    const fresh = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
    expect(fresh.exec('per Section 01 32 01.00 10 requirements')?.[1]).toBe('01 32 01.00 10');
  });
});

describe('STANDARD_ORG_PATTERNS', () => {
  const expectedOrgs = [
    'ASTM',
    'ANSI',
    'IEEE',
    'NFPA',
    'UL',
    'NEMA',
    'NEC',
    'TIA',
    'BICSI',
    'ASME',
    'ASHRAE',
  ];

  it('includes all 11 expected orgs', () => {
    const codes = STANDARD_ORG_PATTERNS.map((o) => o.orgCode);
    for (const expected of expectedOrgs) {
      expect(codes).toContain(expected);
    }
    expect(codes.length).toBe(expectedOrgs.length);
  });

  it('every org has orgCode, displayName, identifierPattern', () => {
    for (const org of STANDARD_ORG_PATTERNS) {
      expect(org.orgCode).toBeTruthy();
      expect(org.displayName).toBeTruthy();
      expect(org.identifierPattern).toBeTruthy();
    }
  });
});

describe('buildStandardRefRules', () => {
  it('returns one rule per org', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    expect(rules.length).toBe(STANDARD_ORG_PATTERNS.length);
  });

  it('each generated rule id is prefixed standard-<lowercased-org>', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    for (const rule of rules) {
      expect(rule.id).toMatch(/^standard-[a-z]+$/);
    }
  });

  it('each generated rule has targetType=standard', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    for (const rule of rules) {
      expect(rule.targetType).toBe('standard');
    }
  });

  it('pattern captures org code as group 1 and identifier as group 2', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    const astmRule = rules.find((r) => r.id === 'standard-astm')!;
    // Non-global clone so capture groups are stable across runs.
    const reSingle = new RegExp(astmRule.pattern.source);
    const capture = reSingle.exec('Comply with ASTM C150 throughout.');
    expect(capture).not.toBeNull();
    expect(capture![1]).toBe('ASTM');
    expect(capture![2]).toBe('C150');
  });

  it('ASTM example "ASTM C150" matches', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    const re = new RegExp(rules.find((r) => r.id === 'standard-astm')!.pattern.source);
    expect(re.test('ASTM C150')).toBe(true);
  });

  it('NFPA example "NFPA 70" matches', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    const re = new RegExp(rules.find((r) => r.id === 'standard-nfpa')!.pattern.source);
    expect(re.test('See NFPA 70 for compliance.')).toBe(true);
  });

  it('IEEE example "IEEE 802.3" matches', () => {
    const rules = buildStandardRefRules(STANDARD_ORG_PATTERNS);
    const re = new RegExp(rules.find((r) => r.id === 'standard-ieee')!.pattern.source);
    expect(re.test('Comply with IEEE 802.3 Ethernet.')).toBe(true);
  });
});
