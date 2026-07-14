import { describe, it, expect } from 'vitest';
import {
  recognizeFieldCode,
  collapseComplexFields,
  matchKnownSectionField,
  toHeaderFooterVisualStyle,
  isCollapsedFieldRun,
} from './header-footer-field-recognition.js';
import type { RunProperties } from '../../ast/index.js';

const KNOWN = { section: '09 91 26', title: 'STAINING AND TRANSPARENT FINISHING' };

// ─── matchKnownSectionField ─────────────────────────────────────────────────
//
// INVARIANT (ADR-068, #306): recognized spec section-number/title fields map
// to field references derived from meta.section/meta.title — literal
// equality only, never a guessed/partial-match field reference.
describe('matchKnownSectionField', () => {
  it('matches text exactly equal to the known section number', () => {
    expect(matchKnownSectionField('09 91 26', KNOWN)).toBe('sectionNumber');
  });

  it('matches text exactly equal to the known section title', () => {
    expect(matchKnownSectionField('STAINING AND TRANSPARENT FINISHING', KNOWN)).toBe(
      'sectionTitle'
    );
  });

  it('returns undefined for text that does not match either literal', () => {
    expect(matchKnownSectionField('some other text', KNOWN)).toBeUndefined();
  });

  // Pins the "never guessed" half of the invariant: a text value that merely
  // CONTAINS the known section number is not a decidable field reference —
  // fabricating one here would misattribute unrelated header/footer text.
  it('does not match on partial/substring containment of the section number', () => {
    expect(matchKnownSectionField('Section 09 91 26 — Draft', KNOWN)).toBeUndefined();
  });

  it('does not match on partial/substring containment of the title', () => {
    expect(matchKnownSectionField('STAINING AND TRANSPARENT FINISHING (Revised)', KNOWN)).toBe(
      undefined
    );
  });

  it('returns undefined for a recognized-but-unmapped field code text, never a guessed reference', () => {
    // A cached PAGE field's display text ("3") never matches a known section
    // literal — it must fall through to undefined, not be coerced into either.
    expect(matchKnownSectionField('3', KNOWN)).toBeUndefined();
  });

  it('is case-sensitive — no normalization that could fabricate a match', () => {
    expect(matchKnownSectionField('staining and transparent finishing', KNOWN)).toBeUndefined();
  });
});

// ─── recognizeFieldCode ──────────────────────────────────────────────────────

describe('recognizeFieldCode', () => {
  it('recognizes a PAGE field instruction', () => {
    expect(recognizeFieldCode(' PAGE ')).toBe('page');
  });

  it('recognizes a DATE field instruction with format switches', () => {
    expect(recognizeFieldCode(' DATE \\@ "M/d/yyyy" \\* MERGEFORMAT ')).toBe('date');
  });

  it('is case-insensitive on the field keyword', () => {
    expect(recognizeFieldCode(' page ')).toBe('page');
    expect(recognizeFieldCode(' Date ')).toBe('date');
  });

  it('returns unrecognized for an unknown field code', () => {
    expect(recognizeFieldCode(' STYLEREF "Heading 1" ')).toBe('unrecognized');
  });

  it('returns unrecognized for an unrelated field like NUMPAGES', () => {
    expect(recognizeFieldCode(' NUMPAGES ')).toBe('unrecognized');
  });

  it('returns unrecognized for empty/whitespace-only instruction text', () => {
    expect(recognizeFieldCode('')).toBe('unrecognized');
    expect(recognizeFieldCode('   ')).toBe('unrecognized');
  });
});

// ─── collapseComplexFields ───────────────────────────────────────────────────

function fldChar(type: string): Record<string, unknown> {
  return { 'w:fldChar': { '@_w:fldCharType': type } };
}

function instrText(text: string): Record<string, unknown> {
  return { 'w:instrText': text };
}

function plainRun(text: string): Record<string, unknown> {
  return { 'w:t': text };
}

describe('collapseComplexFields', () => {
  it('leaves an ordinary run sequence with no field untouched', () => {
    const runs = [plainRun('Hello '), plainRun('world')];
    expect(collapseComplexFields(runs)).toEqual(runs);
  });

  it('collapses a full begin/instrText/separate/cached/end sequence into one run', () => {
    const runs = [
      plainRun('Page '),
      fldChar('begin'),
      instrText(' PAGE '),
      fldChar('separate'),
      plainRun('3'),
      fldChar('end'),
      plainRun(' of N'),
    ];
    const collapsed = collapseComplexFields(runs);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]).toEqual(plainRun('Page '));
    expect(isCollapsedFieldRun(collapsed[1] as Record<string, unknown>)).toBe(true);
    expect(collapsed[2]).toEqual(plainRun(' of N'));
  });

  it('accumulates a multi-run instruction and reads the recognized field code from it', () => {
    const runs = [
      fldChar('begin'),
      instrText(' DA'),
      instrText('TE '),
      fldChar('separate'),
      plainRun('7/13/2026'),
      fldChar('end'),
    ];
    const collapsed = collapseComplexFields(runs);
    expect(collapsed).toHaveLength(1);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.code).toBe('date');
    expect(marker.__collapsedField.rawInstr).toBe(' DATE ');
    expect(marker.__collapsedField.cachedText).toBe('7/13/2026');
  });

  it('degrades gracefully on a field with no separate/cached phase (still stops at end)', () => {
    const runs = [fldChar('begin'), instrText(' PAGE '), fldChar('end'), plainRun('after')];
    const collapsed = collapseComplexFields(runs);
    expect(collapsed).toHaveLength(2);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.code).toBe('page');
    expect(marker.__collapsedField.cachedText).toBe('');
    expect(collapsed[1]).toEqual(plainRun('after'));
  });

  it('degrades gracefully on a field truncated before end (consumes to the end of runs)', () => {
    const runs = [fldChar('begin'), instrText(' PAGE '), fldChar('separate'), plainRun('3')];
    const collapsed = collapseComplexFields(runs);
    expect(collapsed).toHaveLength(1);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.cachedText).toBe('3');
  });
});

// ─── toHeaderFooterVisualStyle ───────────────────────────────────────────────

describe('toHeaderFooterVisualStyle', () => {
  it('maps recognized RunProperties fields onto HeaderFooterVisualStyle', () => {
    const runProps: RunProperties = {
      rFonts: { ascii: 'Arial' },
      sz: 20,
      b: true,
      i: false,
      caps: true,
      color: 'FF0000',
    };
    expect(toHeaderFooterVisualStyle(runProps)).toEqual({
      fontFamily: 'Arial',
      fontSizeHalfPt: 20,
      bold: true,
      italic: false,
      caps: true,
      color: 'FF0000',
    });
  });

  it('returns undefined for empty RunProperties rather than an empty object', () => {
    expect(toHeaderFooterVisualStyle({})).toBeUndefined();
  });

  it('omits unset fields rather than writing them as undefined', () => {
    const style = toHeaderFooterVisualStyle({ b: true });
    expect(style).toEqual({ bold: true });
    expect(style && 'fontFamily' in style).toBe(false);
  });
});
