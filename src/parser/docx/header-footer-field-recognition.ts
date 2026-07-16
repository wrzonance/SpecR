// Header/footer field recognition (#306, ADR-068): OOXML complex-field
// collapsing, PAGE/DATE field-code recognition, spec section-number/title
// literal matching, and rPr -> HeaderFooterVisualStyle mapping. Content
// capture itself (paragraph -> region) lives in header-footer-region.ts.

import { asRecord, compact, extractAttrStr } from './xml-utils.js';
import { collectRuns } from './document.js';
import { UNKNOWN_SECTION_IDENTITY } from './core-metadata.js';
import type { RunOrder } from './header-footer-run-order.js';
import type { RunProperties, HeaderFooterVariant } from '../../ast/index.js';

// Local mirror of generator/header-footer-fields.ts's HeaderFooterVisualStyle
// derivation — re-derived here (not imported) because src/parser/docx/ never
// imports from src/generator/ (module-boundary rule, CLAUDE.md). Same
// underlying ast schema, so the two stay structurally identical by
// construction.
export type HeaderFooterVisualStyle = NonNullable<HeaderFooterVariant['style']>;

// ─── field-code recognition ─────────────────────────────────────────────────

export type RecognizedFieldCode = 'page' | 'date' | 'unrecognized';

/**
 * Recognize a raw OOXML field instruction (w:instrText content, e.g.
 * " PAGE " or " DATE \@ \"M/d/yyyy\" \* MERGEFORMAT ") by its leading field
 * keyword. Only PAGE and DATE are modeled; every other field code (STYLEREF,
 * NUMPAGES, ...) is 'unrecognized' — its content is preserved as unmodeled by
 * the caller, never guessed into a field it doesn't represent.
 */
export function recognizeFieldCode(rawInstr: string): RecognizedFieldCode {
  const keyword = rawInstr.trim().split(/\s+/, 1)[0]?.toUpperCase();
  if (keyword === 'PAGE') return 'page';
  if (keyword === 'DATE') return 'date';
  return 'unrecognized';
}

// ─── complex-field collapsing ────────────────────────────────────────────────

export interface CollapsedFieldRun {
  readonly code: RecognizedFieldCode;
  readonly rawInstr: string;
  readonly cachedText: string;
}

// Synthetic marker key on a collapsed run — deliberately not a real OOXML tag
// name, so a collapsed field can never be confused with an actual w:* node
// downstream (mirrors the ABSENT_KEY sentinel convention in consensus-stats.ts).
export const COLLAPSED_FIELD_KEY = '__collapsedField';

export function isCollapsedFieldRun(
  run: Record<string, unknown>
): run is Record<string, unknown> & { readonly __collapsedField: CollapsedFieldRun } {
  return COLLAPSED_FIELD_KEY in run;
}

function isFldCharType(run: Record<string, unknown>, type: string): boolean {
  const fldChar = asRecord(run['w:fldChar']);
  const val = fldChar?.['@_w:fldCharType'];
  return val === type;
}

// Exported for reuse by header-footer-region.ts's cell-text extraction
// (paragraph capture) — the same "string or { '#text': string }" shape
// fast-xml-parser produces for w:t (and w:instrText) needs handling in both
// places. A run (or w:instrText) with MORE THAN ONE text child parses as an
// ARRAY of those pieces (#485 review); flatten and concatenate them so no
// cached/instruction text is dropped (ADR-068: never silently drop content).
export function extractTextLikeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractTextLikeValue).join('');
  const rec = asRecord(value);
  const text = rec?.['#text'];
  return typeof text === 'string' ? text : '';
}

// Scans the instruction phase (runs after w:fldChar begin, up to and
// including w:fldChar separate — or w:fldChar end if the field has no
// separate/cached phase) and returns the accumulated raw instruction text
// plus the index to resume scanning from.
function readInstrPhase(
  runs: readonly Record<string, unknown>[],
  startIndex: number
): { readonly rawInstr: string; readonly nextIndex: number; readonly reachedEnd: boolean } {
  let i = startIndex;
  let rawInstr = '';
  while (i < runs.length) {
    const run = runs[i];
    if (run === undefined) break;
    if (isFldCharType(run, 'separate')) return { rawInstr, nextIndex: i + 1, reachedEnd: false };
    if (isFldCharType(run, 'end')) return { rawInstr, nextIndex: i + 1, reachedEnd: true };
    if ('w:instrText' in run) rawInstr += extractTextLikeValue(run['w:instrText']);
    i++;
  }
  return { rawInstr, nextIndex: i, reachedEnd: true };
}

// Scans the cached-result phase (runs after w:fldChar separate, up to and
// including w:fldChar end) and returns the accumulated cached display text
// plus the index to resume scanning from.
function readCachedPhase(
  runs: readonly Record<string, unknown>[],
  startIndex: number
): { readonly cachedText: string; readonly nextIndex: number } {
  let i = startIndex;
  let cachedText = '';
  while (i < runs.length) {
    const run = runs[i];
    if (run === undefined) break;
    if (isFldCharType(run, 'end')) return { cachedText, nextIndex: i + 1 };
    cachedText += extractTextLikeValue(run['w:t']);
    i++;
  }
  return { cachedText, nextIndex: i };
}

// Decomposed out of collapseComplexFields per ADR-068/spike finding #11 — the
// undecomposed version hit sonarjs/cognitive-complexity 12.
function collapseRunSequence(
  runs: readonly Record<string, unknown>[],
  startIndex: number
): { readonly collapsed: Record<string, unknown>; readonly nextIndex: number } {
  const instr = readInstrPhase(runs, startIndex + 1);
  const cached = instr.reachedEnd
    ? { cachedText: '', nextIndex: instr.nextIndex }
    : readCachedPhase(runs, instr.nextIndex);
  const marker: CollapsedFieldRun = {
    code: recognizeFieldCode(instr.rawInstr),
    rawInstr: instr.rawInstr,
    cachedText: cached.cachedText,
  };
  return {
    collapsed: { [COLLAPSED_FIELD_KEY]: marker },
    nextIndex: cached.nextIndex,
  };
}

// True when a w:fldSimple's own subtree contains a FURTHER field construct — a
// nested w:fldSimple or a complex w:fldChar field. collectRuns (below) gathers
// w:t text at any depth, so an inner field's cached runs would be flattened into
// the outer's cachedText and the inner field's identity silently lost; detecting
// the nested construct lets collapseSimpleField preserve the whole thing as
// unmodeled instead (#485 robustness review). Scans for the tag KEYS only — the
// value shape is irrelevant. Word never emits a nested w:fldSimple; this guards
// hand-authored / non-Word OOXML.
function containsNestedField(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsNestedField);
  const rec = asRecord(node);
  if (!rec) return false;
  if ('w:fldSimple' in rec || 'w:fldChar' in rec) return true;
  return Object.values(rec).some(containsNestedField);
}

// Collapses a single w:fldSimple element (Word's single-tag field shorthand —
// used interchangeably with the begin/separate/end w:fldChar sequence for the
// same field codes, #485) into the same CollapsedFieldRun marker shape as
// collapseRunSequence produces, so downstream capture never needs to know
// which OOXML representation a field was authored in. Pure and tolerant: a
// missing @_w:instr reads as '' (-> 'unrecognized'), and no inner runs reads
// as cachedText: ''. collectRuns (document.ts, imported read-only per
// CLAUDE.md's module-boundary rule) gathers w:t text from every w:r at any
// depth in the subtree, so a field wrapped in e.g. w:sdt is still read.
//
// A field whose subtree holds ANOTHER field (containsNestedField) can't be
// cleanly decomposed by that flat gather — recognizing the outer code would
// absorb the inner field's cached text and drop the inner field with no
// unmodeled entry. Such a construct is forced to 'unrecognized' so the whole
// thing is preserved verbatim as unmodeled downstream, never recognized-and-
// dropped (ADR-068: never silently drop a field).
function collapseSimpleField(
  fldSimple: Record<string, unknown>,
  order?: RunOrder
): Record<string, unknown> {
  const rawInstr = extractAttrStr(fldSimple, '@_w:instr');
  const runs: Record<string, unknown>[] = [];
  collectRuns(fldSimple, runs);
  // collectRuns gathers cached runs in fast-xml-parser's grouped (tag-keyed)
  // order, which reorders an interleaved direct/wrapper-nested cached sequence
  // (e.g. w:r, w:hyperlink>w:r, w:r -> the two direct runs group ahead of the
  // wrapped one). `order` is the per-part run-order side-table, which now also
  // ordinal-izes these nested cached runs (header-footer-run-order.ts), so
  // sorting restores true document order. The sort is a no-op on the common
  // path (a single cached run, or all-direct runs already in order).
  if (order) {
    runs.sort(
      (a, b) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)
    );
  }
  const cachedText = runs.map((r) => extractTextLikeValue(r['w:t'])).join('');
  const code = containsNestedField(fldSimple) ? 'unrecognized' : recognizeFieldCode(rawInstr);
  const marker: CollapsedFieldRun = { code, rawInstr, cachedText };
  return { [COLLAPSED_FIELD_KEY]: marker };
}

/**
 * Collapse each OOXML complex-field run sequence (w:fldChar begin ->
 * w:instrText* -> w:fldChar separate -> cached runs -> w:fldChar end) AND
 * every w:fldSimple element (Word's single-tag field shorthand, #485) in a
 * paragraph's run list into a single synthetic marker run, so downstream
 * capture (header-footer-region.ts) can treat a field as one unit rather than
 * reassembling it — one recognition path regardless of which OOXML
 * representation the field was authored in. Runs outside a field sequence
 * pass through unchanged. A truncated w:fldChar field (missing separate/end)
 * degrades gracefully — it consumes to the end of the run list rather than
 * throwing, since this is a valid-XML, merely-unusual document shape, not a
 * parse error.
 *
 * `order` (OPTIONAL) is the part's run-order side-table (header-footer-run-
 * order.ts), threaded through to collapseSimpleField so a w:fldSimple's cached
 * runs are joined in true document order (#485 review). Callers that only test
 * run structure (never assemble user-visible cached text) may omit it.
 */
export function collapseComplexFields(
  runs: readonly Record<string, unknown>[],
  order?: RunOrder
): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let i = 0;
  while (i < runs.length) {
    const run = runs[i];
    if (run === undefined) {
      i++;
      continue;
    }
    // The PRESENCE of the key marks a field — not a record value. fast-xml-parser
    // renders a childless, attribute-less <w:fldSimple/> as the primitive ''; an
    // asRecord() value guard would skip it and drop the field un-warned. Default a
    // primitive value to {} so an empty/malformed field still collapses to an
    // 'unrecognized' marker (ADR-068: never silently drop), #485 robustness review.
    if ('w:fldSimple' in run) {
      out.push(collapseSimpleField(asRecord(run['w:fldSimple']) ?? {}, order));
      i++;
      continue;
    }
    if (isFldCharType(run, 'begin')) {
      const { collapsed, nextIndex } = collapseRunSequence(runs, i);
      out.push(collapsed);
      i = nextIndex;
    } else {
      out.push(run);
      i++;
    }
  }
  return out;
}

// ─── known section-field matching ───────────────────────────────────────────

export interface KnownSectionIdentity {
  readonly section: string;
  readonly title: string;
}

/**
 * Match literal header/footer text against the section's own core.xml
 * identity (ADR-068: core.xml-literal, never content-inferred). Exact
 * equality only — a substring/partial match is never fabricated into a
 * field reference, since that would misattribute unrelated text.
 *
 * `known.section`/`known.title` independently fall back to
 * UNKNOWN_SECTION_IDENTITY ('unknown') when docProps/core.xml is
 * absent/unreadable or lacks a conforming dc:subject/dc:title
 * (core-metadata.ts). That sentinel is never matched against, even when the
 * header/footer text literally reads "unknown" — otherwise a document with
 * missing metadata would have ordinary text spuriously recognized as a
 * section field reference instead of falling back to a literal field.
 */
export function matchKnownSectionField(
  text: string,
  known: KnownSectionIdentity
): 'sectionNumber' | 'sectionTitle' | undefined {
  if (known.section !== UNKNOWN_SECTION_IDENTITY && text === known.section) return 'sectionNumber';
  if (known.title !== UNKNOWN_SECTION_IDENTITY && text === known.title) return 'sectionTitle';
  return undefined;
}

// ─── visual style mapping ────────────────────────────────────────────────────

/**
 * Map an already-extracted RunProperties (resolver.ts's extractRunProps —
 * reused, not reimplemented) onto the header/footer visual-style shape.
 * w:sz is already stored in half-points (ECMA-376 17.3.2.38), matching
 * fontSizeHalfPt directly — no unit conversion needed. Returns undefined
 * (never an empty object) when no recognized style field is set.
 */
export function toHeaderFooterVisualStyle(
  runProps: RunProperties
): HeaderFooterVisualStyle | undefined {
  const built = compact({
    fontFamily: runProps.rFonts?.ascii,
    fontSizeHalfPt: runProps.sz,
    bold: runProps.b,
    italic: runProps.i,
    caps: runProps.caps,
    color: runProps.color,
  }) as HeaderFooterVisualStyle;
  return Object.keys(built).length > 0 ? built : undefined;
}
