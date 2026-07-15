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

  // Regression (#306 review): index.ts defaults meta.section/meta.title to the
  // literal string 'unknown' whenever docProps/core.xml is absent/unreadable
  // (core-metadata.ts's UNKNOWN_SECTION_IDENTITY) and passes that straight
  // through as `known`. Literal header/footer text that happens to read
  // "unknown" must fall back to a literal field, never be fabricated into a
  // sectionNumber/sectionTitle reference just because it matches the sentinel.
  it('never matches the sectionNumber sentinel when known.section is the "unknown" fallback', () => {
    expect(
      matchKnownSectionField('unknown', { section: 'unknown', title: 'unknown' })
    ).toBeUndefined();
  });

  it('never matches the sectionTitle sentinel when known.title is the "unknown" fallback', () => {
    expect(
      matchKnownSectionField('unknown', { section: '09 91 26', title: 'unknown' })
    ).toBeUndefined();
  });

  it('still matches a real section number when only title fell back to "unknown"', () => {
    expect(matchKnownSectionField('09 91 26', { section: '09 91 26', title: 'unknown' })).toBe(
      'sectionNumber'
    );
  });

  it('still matches a real title when only section fell back to "unknown"', () => {
    expect(
      matchKnownSectionField('STAINING AND TRANSPARENT FINISHING', {
        section: 'unknown',
        title: 'STAINING AND TRANSPARENT FINISHING',
      })
    ).toBe('sectionTitle');
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

// ─── collapseComplexFields: w:fldSimple (#485) ───────────────────────────────
//
// INVARIANT (ADR-068 acceptance criterion 4, cross-representation
// equivalence): a `w:fldSimple` element — Word's single-tag field shorthand,
// used interchangeably with the begin/separate/end `w:fldChar` sequence for
// the SAME field codes — must collapse into a structurally identical
// CollapsedFieldRun marker. Nothing about a field's origin representation
// may leak downstream, and nothing may be silently left un-warned by falling
// through as an unrecognized raw run.
function fldSimpleRun(
  instr: string,
  innerRuns: readonly Record<string, unknown>[] = []
): Record<string, unknown> {
  return {
    'w:fldSimple': {
      '@_w:instr': instr,
      'w:r': innerRuns,
    },
  };
}

describe('collapseComplexFields: w:fldSimple', () => {
  it('collapses a w:fldSimple PAGE field into the same marker shape as a w:fldChar sequence', () => {
    const runs = [fldSimpleRun(' PAGE ', [plainRun('3')])];
    const collapsed = collapseComplexFields(runs);
    expect(collapsed).toHaveLength(1);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.code).toBe('page');
    expect(marker.__collapsedField.rawInstr).toBe(' PAGE ');
    expect(marker.__collapsedField.cachedText).toBe('3');
  });

  it('recognizes a w:fldSimple DATE field and accumulates cached text across multiple inner runs', () => {
    const runs = [fldSimpleRun(' DATE \\@ "M/d/yyyy" ', [plainRun('7/13/'), plainRun('2026')])];
    const collapsed = collapseComplexFields(runs);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.code).toBe('date');
    expect(marker.__collapsedField.cachedText).toBe('7/13/2026');
  });

  it('collapses an unrecognized field code (e.g. STYLEREF) rather than leaving it as a raw, un-warnable run', () => {
    const runs = [fldSimpleRun(' STYLEREF "Heading 1" ', [plainRun('Some Style Text')])];
    const collapsed = collapseComplexFields(runs);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.code).toBe('unrecognized');
    expect(marker.__collapsedField.cachedText).toBe('Some Style Text');
  });

  it('tolerates a missing @_w:instr attribute (empty rawInstr -> unrecognized)', () => {
    const runs = [{ 'w:fldSimple': { 'w:r': [plainRun('x')] } }];
    const collapsed = collapseComplexFields(runs);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.rawInstr).toBe('');
    expect(marker.__collapsedField.code).toBe('unrecognized');
  });

  it('tolerates a w:fldSimple with no inner runs (empty cachedText, never thrown)', () => {
    const runs = [{ 'w:fldSimple': { '@_w:instr': ' PAGE ' } }];
    const collapsed = collapseComplexFields(runs);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.cachedText).toBe('');
  });

  it('leaves surrounding plain runs untouched, collapsing only the w:fldSimple in the middle', () => {
    const runs = [plainRun('Page '), fldSimpleRun(' PAGE ', [plainRun('3')]), plainRun(' of N')];
    const collapsed = collapseComplexFields(runs);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]).toEqual(plainRun('Page '));
    expect(isCollapsedFieldRun(collapsed[1] as Record<string, unknown>)).toBe(true);
    expect(collapsed[2]).toEqual(plainRun(' of N'));
  });

  it('reads cached text from runs nested inside a wrapper (e.g. w:sdt) within the w:fldSimple, via collectRuns traversal', () => {
    const nested = {
      'w:fldSimple': {
        '@_w:instr': ' PAGE ',
        'w:sdt': { 'w:sdtContent': { 'w:r': [plainRun('5')] } },
      },
    };
    const collapsed = collapseComplexFields([nested]);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.cachedText).toBe('5');
  });

  // Regression (#485 robustness review): fast-xml-parser renders a childless,
  // attribute-less <w:fldSimple/> (or <w:fldSimple></w:fldSimple>) as the
  // PRIMITIVE '' — not a record — so an asRecord() value guard skips it and the
  // raw run falls through un-collapsed, dropping the field with no unmodeled
  // entry and no warning. The presence of the KEY, not a record value, marks a
  // field: an empty/malformed field must still surface as unrecognized (ADR-068:
  // never silently drop).
  it('collapses a childless, attribute-less w:fldSimple (parser primitive "") into an unrecognized field rather than silently dropping it', () => {
    const runs = [{ 'w:fldSimple': '' }];
    const collapsed = collapseComplexFields(runs);
    expect(collapsed).toHaveLength(1);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.code).toBe('unrecognized');
    expect(marker.__collapsedField.rawInstr).toBe('');
    expect(marker.__collapsedField.cachedText).toBe('');
  });

  // Regression (#485 robustness review): a w:fldSimple whose own subtree holds
  // ANOTHER field (a nested w:fldSimple here) is schema-valid but a shape Word
  // never emits. collapseSimpleField's flat collectRuns gather would recognize
  // the OUTER code (' PAGE ' -> page) and absorb the inner field's cached runs
  // into the outer's cachedText, dropping the inner field's identity with no
  // unmodeled entry. Rather than recognize-and-drop, the whole construct is
  // preserved verbatim as one unrecognized (unmodeled) field (ADR-068).
  it('downgrades a w:fldSimple containing a nested field to unrecognized, so the nested field is never silently dropped', () => {
    const runs = [
      {
        'w:fldSimple': {
          '@_w:instr': ' PAGE ',
          'w:fldSimple': { '@_w:instr': ' NUMPAGES ', 'w:r': [plainRun('7')] },
        },
      },
    ];
    const collapsed = collapseComplexFields(runs);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.code).toBe('unrecognized');
    expect(marker.__collapsedField.rawInstr).toBe(' PAGE ');
  });

  // Regression (#485 CodeRabbit review): a single w:r with multiple w:t children
  // makes r['w:t'] an ARRAY; extractTextLikeValue returned '' for arrays, so the
  // field's cached display text was silently dropped. The text-like extractor now
  // flattens arrays, concatenating every w:t piece (ADR-068: never drop content).
  it('concatenates cached text from a run carrying multiple w:t children (array-valued w:t)', () => {
    const runs = [
      { 'w:fldSimple': { '@_w:instr': ' STYLEREF ', 'w:r': { 'w:t': ['Div 09 ', '91 26'] } } },
    ];
    const collapsed = collapseComplexFields(runs);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.cachedText).toBe('Div 09 91 26');
  });

  // A nested complex w:fldChar field inside a w:fldSimple is caught by the same
  // guard — its instrText/cached runs would otherwise be flattened away.
  it('downgrades a w:fldSimple containing a nested w:fldChar complex field to unrecognized', () => {
    const runs = [
      {
        'w:fldSimple': {
          '@_w:instr': ' PAGE ',
          'w:r': [{ 'w:fldChar': { '@_w:fldCharType': 'begin' } }],
        },
      },
    ];
    const collapsed = collapseComplexFields(runs);
    const marker = collapsed[0];
    if (marker === undefined || !isCollapsedFieldRun(marker)) {
      throw new Error('expected a collapsed field run');
    }
    expect(marker.__collapsedField.code).toBe('unrecognized');
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
