import { describe, it, expect } from 'vitest';
import {
  matchTextSignal,
  matchIndentSignal,
  isSpecifierNote,
  isPartHeading,
  isDecorationSeparator,
} from './heuristics.js';

describe('matchTextSignal', () => {
  it('detects PART heading', () => {
    expect(matchTextSignal('PART 1 - GENERAL')).toEqual({ nodeType: 'part', normalizedIlvl: 0 });
  });

  it('detects article (N.N format)', () => {
    expect(matchTextSignal('1.1 REFERENCES')).toEqual({ nodeType: 'article', normalizedIlvl: 1 });
  });

  // Regression (CPI_DATA_COMMUNICATIONS_WIRELESS_ACCESS_POINTS.docx): PART headings
  // written in whole-number decimal form ("2.0 PRODUCTS", "3.0 EXECUTION") are
  // unstyled/unnumbered, so only Signal 4 sees them. The article pattern ^\d+\.\d+
  // would eat "2.0 " as an article number and nest PRODUCTS/EXECUTION under PART 1,
  // collapsing the whole doc to one part. A "N.0" + canonical part name is a PART.
  it('classifies "N.0 <canonical part name>" as a PART, not an article', () => {
    expect(matchTextSignal('2.0 PRODUCTS')).toEqual({ nodeType: 'part', normalizedIlvl: 0 });
    expect(matchTextSignal('3.0 EXECUTION')).toEqual({ nodeType: 'part', normalizedIlvl: 0 });
    expect(matchTextSignal('1.0 GENERAL')).toEqual({ nodeType: 'part', normalizedIlvl: 0 });
    expect(matchTextSignal('2.00 PRODUCTS AND MATERIALS')).toEqual({
      nodeType: 'part',
      normalizedIlvl: 0,
    });
  });

  // Regression (WIRELESS_ACCESS_POINTS.docx): a doc with NO Word numbering/styles
  // types its outline as a decimal ladder — N.N articles, N.N.N sub-items, N.N.N.N
  // deeper. Only Signal 4 sees these; without deep patterns they fall to continuation
  // and lose all tier. Depth = dot count: N.N=article, N.N.N=pr1, N.N.N.N=pr2, …
  it('classifies a manual multi-level decimal outline (N.N.N deep numbering)', () => {
    expect(matchTextSignal('1.1.1 Wi-Tile')).toEqual({ nodeType: 'pr1', normalizedIlvl: 2 });
    expect(matchTextSignal('1.2.10 In-Plane')).toEqual({ nodeType: 'pr1', normalizedIlvl: 2 });
    expect(matchTextSignal('1.1.1.1 Sub-item')).toEqual({ nodeType: 'pr2', normalizedIlvl: 3 });
    expect(matchTextSignal('2.3.4.5.6 Deep item')).toEqual({ nodeType: 'pr3', normalizedIlvl: 4 });
  });

  it('keeps two-number "N.N" as an article (deep patterns do not disturb it)', () => {
    expect(matchTextSignal('1.2 RELATED SECTIONS')).toEqual({
      nodeType: 'article',
      normalizedIlvl: 1,
    });
    expect(matchTextSignal('10.11 SCHEDULES')).toEqual({ nodeType: 'article', normalizedIlvl: 1 });
  });

  // The N.0 promotion is gated on a canonical part name — a genuine "N.0" article
  // with non-canonical text stays an article (no evidence it is a PART tier), and a
  // real sub-article "N.1 SUMMARY" is never touched.
  it('does NOT promote a non-canonical "N.0" line, and keeps real N.N articles', () => {
    expect(matchTextSignal('2.0 WIDGETS')).toEqual({ nodeType: 'article', normalizedIlvl: 1 });
    expect(matchTextSignal('2.1 SUMMARY')).toEqual({ nodeType: 'article', normalizedIlvl: 1 });
    // "1.0" inside prose is not a heading start (requires the canonical name to follow)
    expect(matchTextSignal('2.0 inches of clearance minimum')).toEqual({
      nodeType: 'article',
      normalizedIlvl: 1,
    });
  });

  it('detects pr1 (uppercase letter dot space)', () => {
    expect(matchTextSignal('A. Provide materials')).toEqual({ nodeType: 'pr1', normalizedIlvl: 2 });
  });

  it('detects pr2 (digit dot space)', () => {
    expect(matchTextSignal('1. text here')).toEqual({ nodeType: 'pr2', normalizedIlvl: 3 });
  });

  it('detects pr3 (lowercase letter dot space)', () => {
    expect(matchTextSignal('a. text here')).toEqual({ nodeType: 'pr3', normalizedIlvl: 4 });
  });

  it('detects pr4 (digit paren space)', () => {
    expect(matchTextSignal('1) text here')).toEqual({ nodeType: 'pr4', normalizedIlvl: 5 });
  });

  it('detects pr5 (lowercase letter paren space)', () => {
    expect(matchTextSignal('a) text here')).toEqual({ nodeType: 'pr5', normalizedIlvl: 6 });
  });

  it('does NOT match pr5 for product code with mid-word paren', () => {
    expect(matchTextSignal('Model XR-3i) series specifications')).toBeNull();
  });

  it('does NOT match pr1 for lowercase letter — only uppercase triggers pr1', () => {
    const result = matchTextSignal('a. text');
    expect(result?.nodeType).toBe('pr3');
  });

  it('does NOT match editorial placeholder', () => {
    expect(matchTextSignal('<Insert manufacturer name here>')).toBeNull();
  });

  it('returns null for text shorter than 4 characters', () => {
    expect(matchTextSignal('A.')).toBeNull();
    expect(matchTextSignal('1.')).toBeNull();
  });

  it('returns null for unmatched plain text', () => {
    expect(matchTextSignal('Lorem ipsum dolor sit amet')).toBeNull();
  });
});

describe('isPartHeading', () => {
  it('detects "PART n" prefixed headings', () => {
    expect(isPartHeading('PART 1 - GENERAL')).toBe(true);
    expect(isPartHeading('part 2 PRODUCTS')).toBe(true);
  });

  // P2 (Codex review): bare canonical names must NOT be promoted on text alone —
  // a generic numbered-list item "GENERAL" at ilvl=0 would otherwise become a
  // spurious PART. The real CPI bare-name case is gated on numbering evidence
  // (specShapedNumIds via the "PART %1" lvlText), not this text guard.
  it('does NOT promote a bare canonical part name without numbering evidence', () => {
    expect(isPartHeading('GENERAL')).toBe(false);
    expect(isPartHeading('  Products  ')).toBe(false);
    expect(isPartHeading('execution')).toBe(false);
  });

  it('rejects body text that merely starts with a canonical part word', () => {
    expect(isPartHeading('GENERAL REQUIREMENTS')).toBe(false);
    expect(isPartHeading('General notes')).toBe(false);
    expect(isPartHeading('PRODUCT DATA')).toBe(false);
  });
});

describe('matchIndentSignal', () => {
  it('returns null for no indentation (0) — indentation never establishes a PART', () => {
    // Regression (08 1416 Flush Wood Doors.docx): a ≈0 indent is not positive evidence
    // of the top (PART) tier — most body text and headers are unindented too. Signal 5
    // must only distinguish article-and-deeper; a real PART is set by numbering / "PART
    // n" text / a part style, never by "not indented". Returning 0 here made an
    // unindented preamble line ("SUMMARY OF CHANGE(S):") a phantom PART.
    expect(matchIndentSignal(0)).toBeNull();
  });

  it('returns null for a negative (hanging/outdent) left indent', () => {
    // -86 twips rounds to -0; the old `estimated < 0` guard let -0 through as ilvl 0 → PART.
    expect(matchIndentSignal(-86)).toBeNull();
  });

  it('returns null for a small positive indent that rounds to 0 (< half a level)', () => {
    expect(matchIndentSignal(200)).toBeNull();
  });

  it('returns 1 for 576 twips (article level)', () => {
    expect(matchIndentSignal(576)).toBe(1);
  });

  it('returns 2 for 1152 twips (pr1 level)', () => {
    expect(matchIndentSignal(1152)).toBe(2);
  });

  it('returns null for undefined leftIndent', () => {
    expect(matchIndentSignal(undefined)).toBeNull();
  });

  it('returns null for ilvl > 8', () => {
    expect(matchIndentSignal(576 * 10)).toBeNull();
  });
});

describe('isDecorationSeparator', () => {
  it('detects pure rule lines (asterisks / dashes / equals, with or without spaces)', () => {
    expect(isDecorationSeparator('****************')).toBe(true);
    expect(isDecorationSeparator('--------')).toBe(true);
    expect(isDecorationSeparator('================')).toBe(true);
    expect(isDecorationSeparator('* * * * *')).toBe(true);
  });

  it('detects "[OR]" / "OR" alternative separators, decorated or bare', () => {
    expect(isDecorationSeparator('****** [OR] ******')).toBe(true);
    expect(isDecorationSeparator('******* [OR] *******')).toBe(true);
    expect(isDecorationSeparator('OR')).toBe(true);
    expect(isDecorationSeparator('--- OR ---')).toBe(true);
    expect(isDecorationSeparator('[ OR ]')).toBe(true);
  });

  it('does NOT catch real content, stray brackets, or fill-in blanks', () => {
    expect(isDecorationSeparator(']')).toBe(false); // orphan bracket from an optional block
    expect(isDecorationSeparator('[Section 09 91 26 – Painting.]')).toBe(false);
    expect(isDecorationSeparator('[__item__]')).toBe(false); // fill-in placeholder
    expect(isDecorationSeparator('END OF SECTION')).toBe(false);
    expect(isDecorationSeparator('A. Provide materials')).toBe(false);
    expect(isDecorationSeparator('FLOOR')).toBe(false); // contains "OR" but is a word
    expect(isDecorationSeparator('--')).toBe(false); // too short to be a rule
    expect(isDecorationSeparator('')).toBe(false);
  });
});

describe('isSpecifierNote — fuzzy specifier-note detection', () => {
  const positives = [
    '** NOTE TO SPECIFIER ** AGF Manufacturing, Inc.; fire sprinkler products.',
    'NOTE TO SPECIFIER: delete items below not required.',
    '## SPECIFIER NOTES ##',
    'NOTES TO SPEC WRITER - choose one of the following.',
    '-- NOTE TO THE SPECIFIER --',
    'SPEC NOTE: verify voltage before ordering.',
    '[SPECIFIER NOTE] coordinate with Division 26.',
  ];
  for (const text of positives) {
    it(`detects: ${text.slice(0, 44)}`, () => {
      expect(isSpecifierNote(text)).toBe(true);
    });
  }

  const negatives = [
    'NOTEWORTHY PRODUCTS INCLUDE THE FOLLOWING',
    'The specifier notes that all work shall comply.',
    'PART 1 GENERAL',
    'NOTES:',
    'NOTE TO USERS OF THIS SECTION',
    'A. Provide written notes to the owner.',
  ];
  for (const text of negatives) {
    it(`rejects: ${text.slice(0, 44)}`, () => {
      expect(isSpecifierNote(text)).toBe(false);
    });
  }
});
