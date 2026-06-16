import { describe, it, expect } from 'vitest';
import { LevelFormat } from 'docx';
import { getNodeLevel, buildSpecNumberingConfig } from './numbering.js';
import { buildRuleMap } from './styles.js';

describe('getNodeLevel', () => {
  it('maps numbered NodeTypes to 0-indexed levels', () => {
    expect(getNodeLevel('part')).toBe(0);
    expect(getNodeLevel('article')).toBe(1);
    expect(getNodeLevel('pr1')).toBe(2);
    expect(getNodeLevel('pr2')).toBe(3);
    expect(getNodeLevel('pr3')).toBe(4);
    expect(getNodeLevel('pr4')).toBe(5);
    expect(getNodeLevel('pr5')).toBe(6);
  });

  it('returns null for unnumbered types', () => {
    expect(getNodeLevel('spec')).toBeNull();
    expect(getNodeLevel('note')).toBeNull();
    expect(getNodeLevel('continuation')).toBeNull();
  });
});

describe('buildSpecNumberingConfig', () => {
  it('returns config with reference spec-numbering', () => {
    const config = buildSpecNumberingConfig();
    expect(config.reference).toBe('spec-numbering');
  });

  it('honors a custom reference (per-section manual numbering instance)', () => {
    const config = buildSpecNumberingConfig(undefined, 'spec-numbering-2');
    expect(config.reference).toBe('spec-numbering-2');
    // Levels are identical to the default — only the reference differs.
    expect(config.levels).toEqual(buildSpecNumberingConfig().levels);
  });

  it('returns exactly 7 levels', () => {
    const config = buildSpecNumberingConfig();
    expect(config.levels).toHaveLength(7);
  });

  it('level 0 is DECIMAL with PART %1 - text (part heading)', () => {
    const config = buildSpecNumberingConfig();
    expect(config.levels[0]?.format).toBe(LevelFormat.DECIMAL);
    expect(config.levels[0]?.text).toBe('PART %1 -');
  });

  it('level 1 is DECIMAL with %1.%2 text (article N.N)', () => {
    const config = buildSpecNumberingConfig();
    expect(config.levels[1]?.format).toBe(LevelFormat.DECIMAL);
    expect(config.levels[1]?.text).toBe('%1.%2');
  });

  it('level 2 is UPPER_LETTER with %3. text (pr1 A.)', () => {
    const config = buildSpecNumberingConfig();
    expect(config.levels[2]?.format).toBe(LevelFormat.UPPER_LETTER);
    expect(config.levels[2]?.text).toBe('%3.');
  });

  it('level 3 is DECIMAL with %4. text (pr2 1.)', () => {
    const config = buildSpecNumberingConfig();
    expect(config.levels[3]?.format).toBe(LevelFormat.DECIMAL);
    expect(config.levels[3]?.text).toBe('%4.');
  });

  it('level 4 is LOWER_LETTER with %5. text (pr3 a.)', () => {
    const config = buildSpecNumberingConfig();
    expect(config.levels[4]?.format).toBe(LevelFormat.LOWER_LETTER);
    expect(config.levels[4]?.text).toBe('%5.');
  });

  it('level 5 text ends with ) for pr4 1)', () => {
    const config = buildSpecNumberingConfig();
    expect(config.levels[5]?.text).toBe('%6)');
  });

  it('level 6 is LOWER_LETTER with ) suffix for pr5 a)', () => {
    const config = buildSpecNumberingConfig();
    expect(config.levels[6]?.format).toBe(LevelFormat.LOWER_LETTER);
    expect(config.levels[6]?.text).toBe('%7)');
  });

  it('all levels have alignment defined', () => {
    const config = buildSpecNumberingConfig();
    for (const lvl of config.levels) {
      expect(lvl.alignment).toBeDefined();
    }
  });
});

describe('buildSpecNumberingConfig — template overrides', () => {
  it('no rules → identical to default config', () => {
    expect(buildSpecNumberingConfig(buildRuleMap([]))).toEqual(buildSpecNumberingConfig());
  });

  it('applies lvlText, numFmt, and start for the matching nodeType level', () => {
    const rules = buildRuleMap([
      {
        nodeType: 'part',
        properties: { numbering: { lvlText: 'SECTION %1 -', numFmt: 'upperRoman', start: 2 } },
      },
    ]);
    const config = buildSpecNumberingConfig(rules);
    const level0 = config.levels.find((l) => l.level === 0);
    expect(level0).toMatchObject({ text: 'SECTION %1 -', format: 'upperRoman', start: 2 });
    expect(config.levels.find((l) => l.level === 1)).toEqual(
      buildSpecNumberingConfig().levels.find((l) => l.level === 1)
    );
  });

  it('ignores unknown numFmt (keeps default format)', () => {
    const rules = buildRuleMap([
      { nodeType: 'article', properties: { numbering: { numFmt: 'klingon' } } },
    ]);
    const level1 = buildSpecNumberingConfig(rules).levels.find((l) => l.level === 1);
    expect(level1?.format).toBe('decimal');
  });

  it('ignores template ilvl — level mapping stays generator-owned', () => {
    const rules = buildRuleMap([
      { nodeType: 'pr1', properties: { numbering: { ilvl: 5, lvlText: '%3:' } } },
    ]);
    const config = buildSpecNumberingConfig(rules);
    expect(config.levels.find((l) => l.level === 2)?.text).toBe('%3:');
    expect(config.levels.find((l) => l.level === 5)?.text).toBe('%6)');
  });
});
