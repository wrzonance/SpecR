import { describe, it, expect } from 'vitest';
import {
  escapeLiteralForRegex,
  buildTermMatcher,
  scanParagraphForCategory,
  scanSpecForMissingPhrases,
  type LanguageScanParagraph,
} from './language-rule-findings.js';
import type { LanguageRuleTerm } from '../../ast/index.js';

// #411 / ADR-080 — pure-function unit coverage for the findings scan engine
// (task 5/8). DB-touching pieces (loadScannableParagraphs,
// getLanguageFindingsReport) are covered by
// language-rule-findings.integration.test.ts instead (this project's unit
// project runs with no DB, per CLAUDE.md).

function paragraph(text: string): LanguageScanParagraph {
  return { id: 'para-1', specId: 'spec-1', section: '09 91 26', text };
}

describe('escapeLiteralForRegex', () => {
  it('escapes every regex metacharacter so a literal term is never interpreted as a pattern', () => {
    expect(escapeLiteralForRegex('A.E.')).toBe('A\\.E\\.');
    expect(escapeLiteralForRegex('a+b?c')).toBe('a\\+b\\?c');
  });

  it('leaves plain word characters and spaces untouched', () => {
    expect(escapeLiteralForRegex('furnish and install')).toBe('furnish and install');
  });
});

describe('buildTermMatcher — D6 lookaround boundaries, not \\b (ADR-080 spike correction)', () => {
  it('a metachar-containing literal term matches only the literal text, never as a wildcard', () => {
    const matcher = buildTermMatcher({ term: 'A.E.' });
    expect(matcher?.test('Contact the AXE for approval.')).toBe(false);
  });

  it("'all' inside 'install' does NOT match (no substring false positive)", () => {
    const matcher = buildTermMatcher({ term: 'all' });
    expect(matcher?.test('Furnish and install the unit.')).toBe(false);
  });

  it("'all' as a standalone word DOES match", () => {
    const matcher = buildTermMatcher({ term: 'all' });
    expect(matcher?.test('Provide all required accessories.')).toBe(true);
  });

  it('language-rule matcher: \\b fails on punctuation-edged terms — A.E. false negative', () => {
    // Regression for the exact spike-caught bug: \b only fires at a
    // word-char <-> non-word-char transition, so a term whose own edge is
    // already non-word ("A.E.") never produces that transition under a
    // naive \b-wrapped matcher — the rule would silently never match. This
    // is the issue's own headline party-vocabulary example.
    const matcher = buildTermMatcher({ term: 'A.E.' });
    expect(matcher?.test('Submit shop drawings to the A.E. for review.')).toBe(true);
  });

  it('a multi-word phrase term matches across its own internal spaces', () => {
    const matcher = buildTermMatcher({ term: 'furnish and install' });
    expect(matcher?.test('Furnish and install the equipment per spec.')).toBe(true);
  });

  it('isRegex:true is used verbatim, with no automatic boundary wrapping', () => {
    const matcher = buildTermMatcher({ term: 'sub-?contractor', isRegex: true });
    expect(matcher?.test('the subcontractor shall notify the owner')).toBe(true);
  });

  it('an invalid isRegex:true pattern degrades to null and never throws', () => {
    expect(() => buildTermMatcher({ term: '(unterminated', isRegex: true })).not.toThrow();
    expect(buildTermMatcher({ term: '(unterminated', isRegex: true })).toBeNull();
  });
});

describe('scanParagraphForCategory', () => {
  it('flags a matched literal term with category, location, and the matched text', () => {
    const p = paragraph('Submit shop drawings to the A.E. for review.');
    const terms: readonly LanguageRuleTerm[] = [{ term: 'A.E.', suggestion: 'use the firm name' }];
    expect(scanParagraphForCategory(p, terms, 'partyVocabulary')).toEqual([
      {
        type: 'language_term_flagged',
        category: 'partyVocabulary',
        term: 'A.E.',
        suggestion: 'use the firm name',
        specId: 'spec-1',
        section: '09 91 26',
        paragraphId: 'para-1',
        matchedText: 'A.E.',
      },
    ]);
  });

  it('a term with no suggestion authored reports suggestion: null, not undefined', () => {
    const p = paragraph('The Contractor shall comply.');
    const findings = scanParagraphForCategory(p, [{ term: 'shall' }], 'bannedTerm');
    expect(findings[0]?.suggestion ?? null).toBeNull();
  });

  it('does not flag a term that never appears in the paragraph', () => {
    const p = paragraph('Provide painting per manufacturer instructions.');
    expect(scanParagraphForCategory(p, [{ term: 'subcontractor' }], 'partyVocabulary')).toEqual([]);
  });

  it('an invalid isRegex:true term is skipped, not thrown, alongside a valid term', () => {
    const p = paragraph('Submit shop drawings to the A.E. for review.');
    const terms: readonly LanguageRuleTerm[] = [
      { term: '(unterminated', isRegex: true },
      { term: 'A.E.' },
    ];
    const findings = scanParagraphForCategory(p, terms, 'partyVocabulary');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ term: 'A.E.' });
  });

  it('opt-in default: an empty terms list produces no findings', () => {
    const p = paragraph('The Contractor shall comply with all requirements.');
    expect(scanParagraphForCategory(p, [], 'bannedTerm')).toEqual([]);
  });
});

describe('scanSpecForMissingPhrases — whole-spec presence, never paragraph-located (D8)', () => {
  it('reports language_phrase_missing (no paragraphId field) when absent anywhere in the spec', () => {
    const findings = scanSpecForMissingPhrases(
      'spec-1',
      '09 91 26',
      'Provide painting per manufacturer instructions. If required, apply a second coat.',
      [{ term: 'furnish and install', suggestion: 'use standard phrasing' }]
    );
    expect(findings).toEqual([
      {
        type: 'language_phrase_missing',
        phrase: 'furnish and install',
        suggestion: 'use standard phrasing',
        specId: 'spec-1',
        section: '09 91 26',
      },
    ]);
    expect(findings[0]).not.toHaveProperty('paragraphId');
  });

  it('reports no finding when the phrase is present anywhere in the concatenated text', () => {
    const findings = scanSpecForMissingPhrases(
      'spec-1',
      '09 91 26',
      'General notes.\nFurnish and install the equipment per manufacturer instructions.',
      [{ term: 'furnish and install' }]
    );
    expect(findings).toEqual([]);
  });

  it('an invalid isRegex:true phrase is skipped, not thrown, and reports no finding either way', () => {
    expect(() =>
      scanSpecForMissingPhrases('spec-1', '09 91 26', 'some scanned text', [
        { term: '(unterminated', isRegex: true },
      ])
    ).not.toThrow();
    expect(
      scanSpecForMissingPhrases('spec-1', '09 91 26', 'some scanned text', [
        { term: '(unterminated', isRegex: true },
      ])
    ).toEqual([]);
  });

  it('opt-in default: an empty phrases list produces no findings', () => {
    expect(scanSpecForMissingPhrases('spec-1', '09 91 26', 'any scanned text', [])).toEqual([]);
  });
});
