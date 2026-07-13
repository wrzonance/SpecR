// src/lib/section-number.test.ts
import { describe, it, expect } from 'vitest';
import {
  SECTION_NUMBER_RE,
  sectionNumberFragment,
  sectionNumberCandidateFragment,
  normalizeSectionNumber,
  parseSectionNumberCandidate,
  parseSectionNumberFormat,
  formatSectionNumber,
  formatSectionReferences,
  findSectionNumbers,
  displaySectionNumber,
  SectionNumberSchema,
} from './section-number.js';

describe('SECTION_NUMBER_RE', () => {
  it.each(['26 00 13', '26 00 13.10', '26 00 13.20', '01 32 01.00 10', '27 05 13.43'])(
    'accepts canonical %s',
    (s) => {
      expect(SECTION_NUMBER_RE.test(s)).toBe(true);
    }
  );

  it.each([
    '26 00 13.1', //     one-digit suffix
    '26 00 13.100', //   three-digit suffix
    '26 00 13.10 5', //  one-digit agency
    '26 00 13 10', //    agency without dotted suffix
    '2600 13', //        missing separator
    '26 00 13.10.20', // double dot
    '26  00 13', //      double internal space (canonical form is single-space)
    ' 26 00 13', //      leading space
    'unknown', //        sentinel is NOT a section number
  ])('rejects %s', (s) => {
    expect(SECTION_NUMBER_RE.test(s)).toBe(false);
  });
});

describe('normalizeSectionNumber', () => {
  it('passes canonical forms through', () => {
    expect(normalizeSectionNumber('26 00 13')).toBe('26 00 13');
    expect(normalizeSectionNumber('01 32 01.00 10')).toBe('01 32 01.00 10');
  });

  it('canonicalizes corpus whitespace dirt: leading/trailing/double spaces', () => {
    expect(normalizeSectionNumber(' 26 00 13 ')).toBe('26 00 13');
    expect(normalizeSectionNumber('26  00  13.10')).toBe('26 00 13.10');
  });

  it('canonicalizes NBSP separators', () => {
    expect(normalizeSectionNumber('26 00 13.10')).toBe('26 00 13.10');
  });

  it('returns null for non-section strings', () => {
    expect(normalizeSectionNumber('PAINTING')).toBeNull();
    expect(normalizeSectionNumber('26 00 13.1')).toBeNull();
    expect(normalizeSectionNumber('')).toBeNull();
    expect(normalizeSectionNumber('unknown')).toBeNull();
  });
});

describe('parseSectionNumberCandidate', () => {
  it('passes canonical forms through', () => {
    const result = parseSectionNumberCandidate('09 91 00', 'strong');
    expect(result).toEqual({
      ok: true,
      canonical: '09 91 00',
      inputFormat: 'canonical',
      confidence: 'high',
    });
  });

  it.each([
    ['099100', '09 91 00', 'compact'],
    ['09.91.00', '09 91 00', 'dots'],
    ['09 9100', '09 91 00', 'spaced-compact'],
  ])('normalizes strong-context base variant %s', (raw, canonical, inputFormat) => {
    expect(parseSectionNumberCandidate(raw, 'strong')).toMatchObject({
      ok: true,
      canonical,
      inputFormat,
    });
  });

  it.each([
    ['013201.00 10', '01 32 01.00 10', 'compact'],
    ['01.32.01.00 10', '01 32 01.00 10', 'dots'],
    ['01 3201.00 10', '01 32 01.00 10', 'spaced-compact'],
    ['260013.10', '26 00 13.10', 'compact'],
    ['26.00.13.10', '26 00 13.10', 'dots'],
  ])('normalizes strong-context suffixed variant %s', (raw, canonical, inputFormat) => {
    expect(parseSectionNumberCandidate(raw, 'strong')).toMatchObject({
      ok: true,
      canonical,
      inputFormat,
    });
  });

  it('keeps variants invalid in canonical-only context', () => {
    expect(parseSectionNumberCandidate('099100')).toEqual({ ok: false, reason: 'not-canonical' });
  });

  it.each(['99100', '0991000', '09.910.0', '09 910', '0132010010'])(
    'rejects invalid or ambiguous group lengths: %s',
    (raw) => {
      expect(parseSectionNumberCandidate(raw, 'strong').ok).toBe(false);
    }
  );
});

describe('sectionNumberCandidateFragment', () => {
  it('embeds into a strong keyword scanner and captures variants as group 1', () => {
    const re = new RegExp(String.raw`\bSECTION\s+${sectionNumberCandidateFragment()}`, 'i');
    expect(re.exec('SECTION 099100 PAINTING')?.[1]).toBe('099100');
    expect(re.exec('SECTION 09.91.00 PAINTING')?.[1]).toBe('09.91.00');
    expect(re.exec('SECTION 09 9100 PAINTING')?.[1]).toBe('09 9100');
    expect(re.exec('SECTION 013201.00 10 QUALITY')?.[1]).toBe('013201.00 10');
  });
});

describe('formatSectionNumber', () => {
  it.each([
    ['09 91 00', 'canonical', '09 91 00'],
    ['09 91 00', 'dots', '09.91.00'],
    ['09 91 00', 'compact', '099100'],
    ['09 91 00', 'spaced-compact', '09 9100'],
    ['01 32 01.00 10', 'dots', '01.32.01.00 10'],
    ['01 32 01.00 10', 'compact', '013201.00 10'],
    ['01 32 01.00 10', 'spaced-compact', '01 3201.00 10'],
  ] as const)('formats %s as %s', (canonical, format, expected) => {
    expect(formatSectionNumber(canonical, format)).toBe(expected);
  });

  it('rejects noncanonical input instead of guessing', () => {
    expect(() => formatSectionNumber('099100', 'dots')).toThrow(/canonical/);
  });
});

describe('displaySectionNumber', () => {
  it('normalizes a raw section number and formats it', () => {
    expect(displaySectionNumber('26  00 13', 'dots')).toBe('26.00.13');
  });

  it('passes an already-canonical section number through the requested format', () => {
    expect(displaySectionNumber('09 91 00', 'compact')).toBe('099100');
  });

  it('falls back to the raw string verbatim when it is not a valid section number', () => {
    expect(displaySectionNumber('unknown', 'dots')).toBe('unknown');
  });

  it('never throws on unformattable input', () => {
    expect(() => displaySectionNumber('', 'canonical')).not.toThrow();
  });
});

describe('formatSectionReferences', () => {
  it('formats confident Section-prefixed references', () => {
    expect(formatSectionReferences('See Section 09 91 00 and SECTION 26 00 13.10.', 'dots')).toBe(
      'See Section 09.91.00 and SECTION 26.00.13.10.'
    );
  });

  it('normalizes display variants while preserving the Section keyword casing', () => {
    expect(formatSectionReferences('See section 099100 for painting.', 'canonical')).toBe(
      'See section 09 91 00 for painting.'
    );
  });

  it('does not rewrite bare product or standards-like numbers', () => {
    const text = 'Manufacturer Part No. 099100; ASME 123456; ASTM 123456.';
    expect(formatSectionReferences(text, 'dots')).toBe(text);
  });

  it('formats Section references to spaced-compact', () => {
    expect(formatSectionReferences('See Section 09 91 00 for painting.', 'spaced-compact')).toBe(
      'See Section 09 9100 for painting.'
    );
  });
});

describe('sectionNumberFragment', () => {
  it('embeds into a keyword scanner and captures the full number as group 1', () => {
    const re = new RegExp(String.raw`\bSECTION\s+${sectionNumberFragment()}`, 'i');
    expect(re.exec('SECTION 26 00 13.10 PANELBOARDS')?.[1]).toBe('26 00 13.10');
    expect(re.exec('SECTION 01 32 01.00 10 QUALITY')?.[1]).toBe('01 32 01.00 10');
    expect(re.exec('SECTION 26 00 13 GENERAL')?.[1]).toBe('26 00 13');
  });

  it('exposes exactly ONE capture group (group 1 = whole number)', () => {
    // length === 2 → [full match, group 1]; consumer-added groups start at 2
    expect(new RegExp(sectionNumberFragment()).exec('26 00 13.10 20')?.length).toBe(2);
  });

  it('does not capture a trailing pair as agency without a dotted suffix', () => {
    const re = new RegExp(String.raw`\bSECTION\s+${sectionNumberFragment()}`, 'i');
    // "20 AMP" must not become an agency suffix — agency requires the dot first
    expect(re.exec('SECTION 26 00 13 20 AMP PANELBOARDS')?.[1]).toBe('26 00 13');
  });

  it('does not match digits glued to longer numbers', () => {
    const re = new RegExp(`^${sectionNumberFragment()}$`);
    expect(re.test('26 00 134')).toBe(false);
    expect(re.test('126 00 13')).toBe(false);
    expect(re.test('26 00 13.1010')).toBe(false);
  });

  it('does not capture agency from a following 4-digit year', () => {
    const re = new RegExp(String.raw`\bSECTION\s+${sectionNumberFragment()}`, 'i');
    expect(re.exec('SECTION 26 00 13.10 2024 EDITION')?.[1]).toBe('26 00 13.10');
  });

  // KNOWN AMBIGUITY: a bare two-digit token after a dotted suffix is
  // indistinguishable from an agency suffix in free prose. We accept the
  // false positive; tagged .SEC <SRF> refs are immune (verbatim path).
  it('KNOWN AMBIGUITY: "26 00 13.10 20 mm" captures 20 as agency', () => {
    const re = new RegExp(String.raw`\bSection\s+${sectionNumberFragment()}`, 'i');
    expect(re.exec('See Section 26 00 13.10 20 mm pipe')?.[1]).toBe('26 00 13.10 20');
  });
});

describe('findSectionNumbers', () => {
  it('finds and normalizes all citations with offsets', () => {
    const text = 'See 26 00 13.10 and also 09 91 00.';
    const found = findSectionNumbers(text);
    expect(found.map((f) => f.value)).toEqual(['26 00 13.10', '09 91 00']);
    expect(found[0]?.index).toBe(4);
  });

  it('returns empty array when nothing matches', () => {
    expect(findSectionNumbers('no numbers here')).toEqual([]);
  });

  it('matches across a newline inter-group separator (\\s+) and normalizes', () => {
    // inter-group separators use \s+, which spans the newline
    const found = findSectionNumbers('26\n00 13');
    expect(found.map((f) => f.value)).toEqual(['26 00 13']);
  });

  it('does not absorb a next-line pair as agency (horizontal-only separator)', () => {
    // agency separator is [^\S\r\n]+ — a 2-digit token on the NEXT line is left out
    const found = findSectionNumbers('see 26 00 13.10\n20 items');
    expect(found.map((f) => f.value)).toEqual(['26 00 13.10']);
  });
});

describe('SectionNumberSchema', () => {
  it('accepts expanded shapes', () => {
    expect(SectionNumberSchema.safeParse('01 32 01.00 10').success).toBe(true);
  });
  it('rejects malformed and sentinel values', () => {
    expect(SectionNumberSchema.safeParse('27210').success).toBe(false);
    expect(SectionNumberSchema.safeParse('unknown').success).toBe(false);
  });
});

describe('parseSectionNumberFormat', () => {
  it('passes through a recognized stored value', () => {
    expect(parseSectionNumberFormat('dots')).toBe('dots');
    expect(parseSectionNumberFormat('spaced-compact')).toBe('spaced-compact');
  });
  it('coerces an out-of-range or garbage stored value to canonical', () => {
    expect(parseSectionNumberFormat('garbage')).toBe('canonical');
    expect(parseSectionNumberFormat('')).toBe('canonical');
  });
});
