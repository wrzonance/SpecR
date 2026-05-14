import { describe, it, expect } from 'vitest';
import { LevelFormat } from 'docx';
import { getNodeLevel, buildCsiNumberingConfig } from './numbering.js';

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

describe('buildCsiNumberingConfig', () => {
  it('returns config with reference csi-numbering', () => {
    const config = buildCsiNumberingConfig();
    expect(config.reference).toBe('csi-numbering');
  });

  it('returns exactly 7 levels', () => {
    const config = buildCsiNumberingConfig();
    expect(config.levels).toHaveLength(7);
  });

  it('level 0 is DECIMAL with PART %1 - text (part heading)', () => {
    const config = buildCsiNumberingConfig();
    expect(config.levels[0]?.format).toBe(LevelFormat.DECIMAL);
    expect(config.levels[0]?.text).toBe('PART %1 -');
  });

  it('level 1 is DECIMAL with %1.%2 text (article N.N)', () => {
    const config = buildCsiNumberingConfig();
    expect(config.levels[1]?.format).toBe(LevelFormat.DECIMAL);
    expect(config.levels[1]?.text).toBe('%1.%2');
  });

  it('level 2 is UPPER_LETTER with %3. text (pr1 A.)', () => {
    const config = buildCsiNumberingConfig();
    expect(config.levels[2]?.format).toBe(LevelFormat.UPPER_LETTER);
    expect(config.levels[2]?.text).toBe('%3.');
  });

  it('level 3 is DECIMAL with %4. text (pr2 1.)', () => {
    const config = buildCsiNumberingConfig();
    expect(config.levels[3]?.format).toBe(LevelFormat.DECIMAL);
    expect(config.levels[3]?.text).toBe('%4.');
  });

  it('level 4 is LOWER_LETTER with %5. text (pr3 a.)', () => {
    const config = buildCsiNumberingConfig();
    expect(config.levels[4]?.format).toBe(LevelFormat.LOWER_LETTER);
    expect(config.levels[4]?.text).toBe('%5.');
  });

  it('level 5 text ends with ) for pr4 1)', () => {
    const config = buildCsiNumberingConfig();
    expect(config.levels[5]?.text).toBe('%6)');
  });

  it('level 6 is LOWER_LETTER with ) suffix for pr5 a)', () => {
    const config = buildCsiNumberingConfig();
    expect(config.levels[6]?.format).toBe(LevelFormat.LOWER_LETTER);
    expect(config.levels[6]?.text).toBe('%7)');
  });

  it('all levels have alignment defined', () => {
    const config = buildCsiNumberingConfig();
    for (const lvl of config.levels) {
      expect(lvl.alignment).toBeDefined();
    }
  });
});
