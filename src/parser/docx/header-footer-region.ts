// Per-region paragraph capture for DOCX header/footer parts (#306, ADR-068):
// reads a single word/header*.xml or word/footer*.xml part and captures its
// first content-bearing paragraph into a HeaderFooterRegion ({left, center,
// right} cells split on tab boundaries, plus a rule-line border passthrough).
// Tab-boundary overflow and any second content-bearing paragraph are
// preserved as unmodeled entries rather than silently dropped (acceptance
// criteria 3/4). A root-level w:tbl (#309, ADR-071) is captured into the
// region's `table` slot by header-footer-table.ts, whose captureTablesForRegion
// this module calls and merges into the same region. Field-code/text
// recognition itself lives in header-footer-field-recognition.ts;
// relationship/section-property discovery lives in
// header-footer-relationships.ts; recovering true document order across an
// interleaved w:fldSimple/w:r sequence (#485 review) lives in
// header-footer-run-order.ts.

import { ParserError } from '../error.js';
import {
  asRecord,
  compact,
  createDocumentXmlParser,
  extractAttrStr,
  toArray,
} from './xml-utils.js';
import { extractRunProps } from './resolver.js';
import {
  collapseComplexFields,
  extractTextLikeValue,
  isCollapsedFieldRun,
  matchKnownSectionField,
  toHeaderFooterVisualStyle,
} from './header-footer-field-recognition.js';
import type {
  CollapsedFieldRun,
  HeaderFooterVisualStyle,
  KnownSectionIdentity,
} from './header-footer-field-recognition.js';
import { captureTablesForRegion } from './header-footer-table.js';
import { resolveDrawingImage } from './header-footer-images.js';
import { computeRunOrder } from './header-footer-run-order.js';
import type { RunOrder } from './header-footer-run-order.js';
import type { HeaderFooterUnmodeledEntry } from './types.js';
import type { HeaderFooterVariant } from '../../ast/index.js';

// Local indexed-access aliases (mirrors the generator's own pattern —
// header-footer-fields.ts/header-footer-regions.ts): the AST barrel exports
// only composition-level types, so the region/cell/field shapes are derived
// structurally off HeaderFooterVariant rather than importing
// ast/header-footer-schemas.ts internals (module-boundary rule).
export type HeaderFooterRegion = NonNullable<HeaderFooterVariant['header']>;
type HeaderFooterCell = NonNullable<HeaderFooterRegion['left']>;
type HeaderFooterField = NonNullable<HeaderFooterCell['content']>[number];
type HeaderFooterRuleLine = NonNullable<HeaderFooterRegion['ruleLine']>;

export interface RegionCaptureResult {
  readonly region: HeaderFooterRegion | undefined;
  readonly unmodeled: readonly HeaderFooterUnmodeledEntry[];
}

// Internal helpers build unmodeled entries before variant/region are known
// at their call depth — stamped on once, at the top of captureRegion, rather
// than threaded through every helper. Exported (shared, not redeclared) so
// header-footer-table.ts's own per-cell/per-table unmodeled entries use the
// exact same shape.
export type PartialUnmodeled = Omit<HeaderFooterUnmodeledEntry, 'variant' | 'region'>;

function stamp(
  variant: HeaderFooterUnmodeledEntry['variant'],
  region: HeaderFooterUnmodeledEntry['region']
): (partial: PartialUnmodeled) => HeaderFooterUnmodeledEntry {
  return (partial) => ({ variant, region, ...partial });
}

// Own instance, scoped to header/footer part vocabulary (w:hdr/w:ftr root,
// w:p/w:r/w:tbl/w:tr/w:tc/w:gridCol as the only repeatable wrapper tags this
// scan needs — the table-structure tags support header-footer-table.ts's
// row/cell/column-width capture) — shares createDocumentXmlParser's
// #22/#120-safe base config (xml-utils).
const partParser = createDocumentXmlParser(['w:p', 'w:r', 'w:tbl', 'w:tr', 'w:tc', 'w:gridCol']);

function partRootKey(region: HeaderFooterUnmodeledEntry['region']): 'w:hdr' | 'w:ftr' {
  return region === 'header' ? 'w:hdr' : 'w:ftr';
}

function parsePartXml(
  partXml: string,
  region: HeaderFooterUnmodeledEntry['region']
): Record<string, unknown> {
  try {
    return partParser.parse(partXml) as Record<string, unknown>;
  } catch (err) {
    throw new ParserError(`failed to parse word/${region} part XML`, {
      code: 'DOCX_HEADER_FOOTER_XML_INVALID',
      cause: err,
    });
  }
}

// ─── paragraph selection ────────────────────────────────────────────────────
//
// Root-level w:tbl detection (ADR-068: a w:tbl cannot nest inside a w:p, so
// it is always a root-level sibling — a structural fact, not a heuristic)
// now lives in header-footer-table.ts's captureTablesForRegion, which reuses
// paragraphsOf/runsOf/paragraphHasContent/isDrawingRun/buildCellContent below
// for its own per-cell content capture.

export function paragraphsOf(root: Record<string, unknown>): readonly Record<string, unknown>[] {
  return toArray<Record<string, unknown>>(
    root['w:p'] as readonly Record<string, unknown>[] | undefined
  );
}

// Terminal-run push for collectRunsAndFields's two dispatch keys (#485): a
// w:r pushes each sibling as-is (matches document.ts's collectRuns exactly),
// while a w:fldSimple re-wraps each sibling under its own tag key so
// header-footer-field-recognition.ts's collapseComplexFields still sees a
// recognizable OOXML-shaped `{ 'w:fldSimple': element }` marker — never a
// bare-unwrapped element and never a pre-collapsed one (decision 3). Shared
// by both terminal branches so collectRunsAndFields's own dispatch stays a
// single merged guard rather than two parallel guard-continues (spike
// learning #2 — three branches measured complexity 11/cognitive 14 against
// the enforced cap of 10).
function pushTerminalRun(
  key: 'w:r' | 'w:fldSimple',
  child: unknown,
  acc: Record<string, unknown>[]
): void {
  const siblings = toArray<Record<string, unknown>>(
    child as readonly Record<string, unknown>[] | undefined
  );
  if (key === 'w:r') {
    acc.push(...siblings);
    return;
  }
  acc.push(...siblings.map((element) => ({ 'w:fldSimple': element })));
}

// Local near-duplicate of document.ts's collectRuns (deliberate — see module
// comment / ADR-068 decision 2), scoped to this module's own terminal
// vocabulary: a header/footer paragraph's runs can nest inside w:hyperlink,
// tracked-change wrappers (w:ins/w:del), or a w:sdt content control, same as
// the main body parser already handles (#306 review); a w:fldSimple element
// (#485) is now ALSO a terminal — its whole subtree is captured as one
// wrapped run rather than recursed into, so a field authored with Word's
// single-tag shorthand survives to collapseComplexFields instead of being
// silently flattened into an ordinary literal run. Two-branch shape (skip
// check, then a single merged w:r|w:fldSimple terminal check) is what clears
// the enforced complexity/cognitive-complexity cap of 10 — mirrors the
// existing collectCellParagraphs precedent in header-footer-table.ts.
//
// CAVEAT this function alone cannot fix (#485 review, CRITICAL): when a
// w:fldSimple sits BETWEEN two w:r terminals at the SAME parent, fast-xml-
// parser's grouped-mode object model merges the second w:r into the first's
// array — this traversal's own Object.entries order then reflects first-tag-
// appearance, not true document order. runsOf (below) corrects that using an
// optional RunOrder side-table from header-footer-run-order.ts; this
// function's OWN push order is intentionally left as-is (it is still correct
// whenever w:r/w:fldSimple never interleave at one parent, and every direct
// caller either passes a RunOrder or is order-independent — see runsOf).
function collectRunsAndFields(value: unknown, acc: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRunsAndFields(item, acc);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'w:rPr' || key === 'w:pPr') continue;
    if (key === 'w:r' || key === 'w:fldSimple') {
      pushTerminalRun(key, child, acc);
      continue;
    }
    collectRunsAndFields(child, acc);
  }
}

// header-footer-run-order.ts's side-table is keyed on the RAW w:fldSimple
// element (the same object header-footer-run-order.ts's walkOrder pairs from
// the grouped parse), but pushTerminalRun above re-wraps that same element
// under a fresh `{ 'w:fldSimple': element }` object for every piece it
// pushes — a NEW object, never reference-equal to the raw element the order
// side-table was keyed on. Unwrap back to that raw element before the
// lookup, exactly undoing pushTerminalRun's own wrapping; a plain w:r piece
// is never wrapped, so it always looks itself up directly. (OOXML's CT_R
// schema never allows a w:fldSimple child of w:r, so this check is
// unambiguous — never a false match against genuine run content.)
function runOrderKey(piece: Record<string, unknown>): Record<string, unknown> {
  const wrapped = piece['w:fldSimple'];
  return wrapped !== null && typeof wrapped === 'object'
    ? (wrapped as Record<string, unknown>)
    : piece;
}

function byRunOrder(
  order: RunOrder
): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  return (a, b) =>
    (order.get(runOrderKey(a)) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(runOrderKey(b)) ?? Number.MAX_SAFE_INTEGER);
}

// `order` is OPTIONAL: callers that only need the run SET (paragraphHasContent
// membership checks, resolveRuleLine's run-free/run-count checks) are order-
// independent and pass nothing, preserving this function's existing direct-
// object-fixture test coverage unchanged. Callers that assemble user-visible
// content (captureFromParagraphs' cell-content call) pass captureRegion's
// per-part RunOrder (#485 review) to restore true document order across an
// interleaved w:fldSimple/w:r sequence that collectRunsAndFields's own
// traversal alone cannot preserve.
export function runsOf(
  paragraph: Record<string, unknown>,
  order?: RunOrder
): readonly Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  collectRunsAndFields(paragraph, runs);
  return order ? [...runs].sort(byRunOrder(order)) : runs;
}

export function paragraphHasContent(runs: readonly Record<string, unknown>[]): boolean {
  return runs.some(
    (r) =>
      'w:t' in r ||
      'w:fldChar' in r ||
      'w:instrText' in r ||
      'w:drawing' in r ||
      'w:pict' in r ||
      'w:fldSimple' in r
  );
}

// ─── rule line / border passthrough (ADR-068, generalized for tables #309) ─

// Inverse of generator/header-footer-regions.ts's ruleLineBorderSize: w:sz is
// eighths of a point (ECMA-376 §17.3.1.24); widthTwips = w:sz / 0.4 (i.e.
// w:sz * 2.5). A local constant, not a shared import — src/parser/docx/ never
// imports src/generator/ (module-boundary rule).
const BORDER_SIZE_PER_TWIP = 0.4;

function ruleLineWidthTwips(szStr: string): number | undefined {
  const sz = parseInt(szStr, 10);
  return isNaN(sz) ? undefined : Math.round(sz / BORDER_SIZE_PER_TWIP);
}

/**
 * Read a single border edge (a `w:*Bdr`-shaped container's `edgeKey` child,
 * e.g. `w:pBdr`'s `w:bottom`, or `w:tblBorders`'s `w:top`) as a verbatim
 * style passthrough (ADR-068/ADR-071): w:val -> style, w:sz -> widthTwips,
 * w:color -> color. `w:val="nil"`/`"none"` explicitly suppresses the border
 * — treated as no rule line at all, not `enabled: false`. Generalized out of
 * the original paragraph-only captureRuleLine (#309) so header-footer-table.ts
 * can reuse the exact same edge-reading logic for a table's `w:tblBorders`.
 */
export function captureBorderEdge(
  borderContainer: Record<string, unknown> | undefined,
  edgeKey: string
): HeaderFooterRuleLine | undefined {
  const border = asRecord(borderContainer?.[edgeKey]);
  if (!border) return undefined;
  const val = extractAttrStr(border, '@_w:val');
  if (val === '' || val === 'nil' || val === 'none') return undefined;
  const szStr = extractAttrStr(border, '@_w:sz');
  const color = extractAttrStr(border, '@_w:color');
  return compact({
    enabled: true,
    style: val,
    widthTwips: szStr === '' ? undefined : ruleLineWidthTwips(szStr),
    color: color === '' ? undefined : color,
  }) as HeaderFooterRuleLine;
}

/**
 * Read a single paragraph's border on `edge` ('bottom' for a header's rule
 * line beneath its text, 'top' for a footer's rule line above it). Thin
 * wrapper over captureBorderEdge, scoped to a paragraph's own w:pBdr
 * container. Used both for a part's first content-bearing paragraph and,
 * via resolveRuleLine (#484), for any standalone border-only paragraph.
 */
function captureRuleLine(
  pPr: Record<string, unknown> | undefined,
  edge: 'top' | 'bottom'
): HeaderFooterRuleLine | undefined {
  return captureBorderEdge(asRecord(pPr?.['w:pBdr']), `w:${edge}`);
}

/**
 * Resolve a region's rule line, honoring a standalone border-only paragraph
 * that carries no runs at all (#484, ADR-068 addendum) — otherwise silently
 * dropped, since `paragraphHasContent` never sees it and it never reaches
 * `first`. `candidates` is every non-content-bearing paragraph across the
 * WHOLE part (position-agnostic: leading, trailing, or the only paragraph)
 * that itself carries a qualifying border on `edge`, in document order.
 *
 * - If the content-bearing paragraph (`first`) has its own border, that
 *   border wins outright — KNOWN AMBIGUITY, OOXML gives no canonical
 *   tiebreak — and every candidate demotes to an `extraParagraph`
 *   unmodeled entry.
 * - Otherwise the first candidate that is genuinely run-free (border ONLY,
 *   no runs at all) promotes into `ruleLine`; every other candidate —
 *   including a bordered paragraph that still carries a non-content run
 *   such as a lone `w:br` — demotes to `extraParagraph`, so promotion never
 *   silently drops that run (ADR-068 criterion 4, #484 review).
 * - No candidates and no border on `first` → unchanged empty behavior.
 */
function resolveRuleLine(
  paragraphs: readonly Record<string, unknown>[],
  first: Record<string, unknown> | undefined,
  edge: 'top' | 'bottom'
): {
  readonly ruleLine: HeaderFooterRuleLine | undefined;
  readonly unmodeled: readonly PartialUnmodeled[];
} {
  const firstRuleLine = first ? captureRuleLine(asRecord(first['w:pPr']), edge) : undefined;
  const candidates = paragraphs
    .filter((p) => !paragraphHasContent(runsOf(p)))
    .map((p) => ({ paragraph: p, border: captureRuleLine(asRecord(p['w:pPr']), edge) }))
    .filter(
      (c): c is { paragraph: Record<string, unknown>; border: HeaderFooterRuleLine } =>
        c.border !== undefined
    );

  const toDemoted = (c: { paragraph: Record<string, unknown> }): PartialUnmodeled => ({
    kind: 'extraParagraph',
    detail: compact(c.paragraph),
  });

  // Only a truly run-free paragraph (border ONLY, no runs at all) is eligible
  // for promotion — matching #484's "no runs at all" contract — so a promoted
  // paragraph never carries a run that capture would then discard. A bordered
  // non-content paragraph that still has runs stays a candidate purely so it
  // is preserved verbatim by demotion, never promoted and never dropped.
  const promoteIdx =
    firstRuleLine !== undefined
      ? -1
      : candidates.findIndex((c) => runsOf(c.paragraph).length === 0);
  const ruleLine = promoteIdx >= 0 ? candidates[promoteIdx]?.border : firstRuleLine;
  return { ruleLine, unmodeled: candidates.filter((_, i) => i !== promoteIdx).map(toDemoted) };
}

// ─── field-marker resolution ────────────────────────────────────────────────

type FieldResolution =
  | { readonly kind: 'field'; readonly field: HeaderFooterField }
  | { readonly kind: 'unmodeled'; readonly entry: PartialUnmodeled };

// PAGE/DATE collapse to a modeled field; every other recognized-but-unmapped
// field code (STYLEREF, NUMPAGES, ...) is preserved as unmodeled content,
// never guessed into a field it doesn't represent (ADR-068).
function resolveFieldMarker(marker: CollapsedFieldRun): FieldResolution {
  if (marker.code === 'page') return { kind: 'field', field: { kind: 'pageNumber' } };
  if (marker.code === 'date') return { kind: 'field', field: { kind: 'date' } };
  return {
    kind: 'unmodeled',
    entry: {
      kind: 'unrecognizedField',
      detail: compact({ rawInstr: marker.rawInstr, cachedText: marker.cachedText }),
    },
  };
}

// FieldResolution and header-footer-images.ts's DrawingResolution are the
// same two-arm shape by design (mirrors each other, see that file's own
// comment) — this single push-site handles either, keeping buildCellContent's
// 3-way branch under the enforced cognitive-complexity cap of 10 (#487).
function applyResolution(
  resolved: FieldResolution,
  content: HeaderFooterField[],
  unmodeled: PartialUnmodeled[]
): void {
  if (resolved.kind === 'field') content.push(resolved.field);
  else unmodeled.push(resolved.entry);
}

// The cell's run-level formatting (bold/italic/color/font/caps, #306 review):
// taken from the first piece that carries a w:rPr, since HeaderFooterCellSchema
// models one style per cell, not one per run — a cell whose runs mix styles only
// has its first run's style captured, a documented simplification (mirrors
// captureRuleLine/captureFromParagraphs's own "first paragraph wins" convention).
// A collapsed complex-field marker never carries a w:rPr (collapseRunSequence
// discards the wrapped runs' own properties), so field-run styling is out of
// scope here.
function firstRunStyle(
  pieces: readonly Record<string, unknown>[]
): HeaderFooterVisualStyle | undefined {
  for (const piece of pieces) {
    if (isCollapsedFieldRun(piece)) continue;
    const style = toHeaderFooterVisualStyle(extractRunProps(asRecord(piece['w:rPr'])));
    if (style !== undefined) return style;
  }
  return undefined;
}

// Builds one cell's content: consecutive plain-text runs are concatenated
// and matched against the known section identity (ADR-068: literal equality
// only); a recognized field marker or a resolvable drawing run each flush
// the buffer first, then contribute their own field or unmodeled entry, in
// original run order (#487). `mediaByRId` is OPTIONAL — its own caller
// (header-footer-table.ts's captureTableCell) never passes it and pre-filters
// drawing runs before this function ever sees them (ADR-071 decision 4:
// table-cell images stay out of scope), so this function's drawing branch is
// reachable only from paragraph/cell-tab-split capture. Exported so
// header-footer-table.ts's per-table-cell capture (#309) reuses the exact
// same literal/field recognition instead of a second implementation.
export function buildCellContent(
  pieces: readonly Record<string, unknown>[],
  known: KnownSectionIdentity,
  mediaByRId?: ReadonlyMap<string, Uint8Array>
): {
  readonly content: readonly HeaderFooterField[];
  readonly unmodeled: readonly PartialUnmodeled[];
  readonly style: HeaderFooterVisualStyle | undefined;
} {
  const content: HeaderFooterField[] = [];
  const unmodeled: PartialUnmodeled[] = [];
  let buffer = '';
  const flushBuffer = (): void => {
    if (buffer === '') return;
    const kind = matchKnownSectionField(buffer, known);
    content.push(kind ? { kind } : { kind: 'literal', text: buffer });
    buffer = '';
  };
  for (const piece of pieces) {
    if (isDrawingRun(piece)) {
      flushBuffer();
      applyResolution(resolveDrawingImage(piece, mediaByRId), content, unmodeled);
      continue;
    }
    if (!isCollapsedFieldRun(piece)) {
      buffer += extractTextLikeValue(piece['w:t']);
      continue;
    }
    flushBuffer();
    applyResolution(resolveFieldMarker(piece.__collapsedField), content, unmodeled);
  }
  flushBuffer();
  return { content, unmodeled, style: firstRunStyle(pieces) };
}

// ─── tab-boundary cell split (ADR-068: KNOWN AMBIGUITY at 3+ tabs) ─────────

// Exported so header-footer-table.ts's table-cell capture (#309) drops an
// image run out of cell content the same way region capture already does.
export function isDrawingRun(run: Record<string, unknown>): boolean {
  return 'w:drawing' in run || 'w:pict' in run;
}

// Splits a run sequence into segments at each w:tab boundary; the tab run
// itself is consumed, never included in a segment.
function splitOnTabs(
  runs: readonly Record<string, unknown>[]
): readonly (readonly Record<string, unknown>[])[] {
  const segments: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  for (const run of runs) {
    if ('w:tab' in run) {
      segments.push(current);
      current = [];
    } else {
      current.push(run);
    }
  }
  segments.push(current);
  return segments;
}

type CellKey = 'left' | 'center' | 'right';

// 0 tabs -> segment 0 is `left`; 1 tab -> `left`/`center` (ADR-068 resolves
// the alignment-dependent ambiguity by convention: segment order, not the
// tab stop's own w:val); 2 tabs -> `left`/`center`/`right`. Any 4th+ segment
// (3+ tabs) has no cell left to hold it and folds into `right` — the KNOWN
// AMBIGUITY case, flagged separately in assignSegmentsToCells.
function cellKeyForIndex(index: number): CellKey {
  if (index === 0) return 'left';
  if (index === 1) return 'center';
  return 'right';
}

// A cell already merged from an earlier segment (the 3+ tabs KNOWN AMBIGUITY
// fold-into-right case) keeps its own already-resolved style — later segments'
// content still merges in, but never displaces the style captured first.
function mergeCell(
  existing: HeaderFooterCell | undefined,
  extra: readonly HeaderFooterField[],
  style: HeaderFooterVisualStyle | undefined
): HeaderFooterCell {
  return compact({
    content: [...(existing?.content ?? []), ...extra],
    style: existing?.style ?? style,
  }) as HeaderFooterCell;
}

function assignSegmentsToCells(
  segments: readonly (readonly Record<string, unknown>[])[],
  known: KnownSectionIdentity,
  mediaByRId?: ReadonlyMap<string, Uint8Array>
): {
  readonly cells: Partial<Record<CellKey, HeaderFooterCell>>;
  readonly unmodeled: readonly PartialUnmodeled[];
} {
  const cells: Partial<Record<CellKey, HeaderFooterCell>> = {};
  const unmodeled: PartialUnmodeled[] = [];
  // Only genuine overflow warrants the warning: a bare trailing tab yields a 4th
  // (empty) segment with nothing folded into `right`, so gate on content past
  // index 2 — not on segment count alone.
  let overflowHasContent = false;
  segments.forEach((segment, index) => {
    const built = buildCellContent(segment, known, mediaByRId);
    unmodeled.push(...built.unmodeled);
    if (built.content.length === 0) return;
    if (index >= 3) overflowHasContent = true;
    const key = cellKeyForIndex(index);
    cells[key] = mergeCell(cells[key], built.content, built.style);
  });
  if (overflowHasContent) {
    unmodeled.push({
      kind: 'unrecognizedField',
      detail: compact({
        reason: 'more than 2 tab stops in one paragraph — extra content folded into right',
        segmentCount: segments.length,
      }),
    });
  }
  return { cells, unmodeled };
}

// Drawing runs flow through splitOnTabs unfiltered (#487) — a w:tab never
// appears inside a w:drawing (ECMA-376 CT_Drawing has no tab-marker child),
// so a drawing run is never mistaken for a tab boundary; it simply rides
// along in whichever segment it falls into and is resolved (or preserved as
// unmodeled) by buildCellContent's own drawing branch.
function splitParagraphIntoCells(
  runs: readonly Record<string, unknown>[],
  known: KnownSectionIdentity,
  order: RunOrder,
  mediaByRId?: ReadonlyMap<string, Uint8Array>
): {
  readonly cells: Partial<Record<CellKey, HeaderFooterCell>>;
  readonly unmodeled: readonly PartialUnmodeled[];
} {
  // `order` also reaches collapseComplexFields (not just the runsOf call that
  // produced `runs`) so a w:fldSimple's own cached runs are joined in true
  // document order, not fast-xml-parser's grouped order (#485 review).
  const collapsed = collapseComplexFields(runs, order);
  const segments = splitOnTabs(collapsed);
  return assignSegmentsToCells(segments, known, mediaByRId);
}

// ─── single-region assembly (at most one per part, ADR-068) ────────────────

function buildRegionFromCells(
  cells: Partial<Record<CellKey, HeaderFooterCell>>,
  ruleLine: HeaderFooterRuleLine | undefined
): HeaderFooterRegion | undefined {
  const built = compact({ left: cells.left, center: cells.center, right: cells.right, ruleLine });
  return Object.keys(built).length > 0 ? (built as HeaderFooterRegion) : undefined;
}

// Only the FIRST content-bearing paragraph in a part is ever captured into a
// region — HeaderFooterRegionSchema models one {left, center, right} row per
// part. Any later content-bearing paragraph is preserved as an
// `extraParagraph` unmodeled entry, never merged into or overwriting the
// first paragraph's capture (ADR-068). A part with NO content-bearing
// paragraph at all can still contribute a region: resolveRuleLine (#484,
// ADR-068 addendum) promotes a standalone border-only paragraph into
// `ruleLine` regardless of whether a content-bearing paragraph exists,
// so this no longer early-returns on `!first`.
function captureFromParagraphs(
  paragraphs: readonly Record<string, unknown>[],
  edge: 'top' | 'bottom',
  known: KnownSectionIdentity,
  order: RunOrder,
  mediaByRId?: ReadonlyMap<string, Uint8Array>
): {
  readonly region: HeaderFooterRegion | undefined;
  readonly unmodeled: readonly PartialUnmodeled[];
} {
  const contentBearing = paragraphs.filter((p) => paragraphHasContent(runsOf(p)));
  const extraUnmodeled: readonly PartialUnmodeled[] = contentBearing
    .slice(1)
    .map((p): PartialUnmodeled => ({ kind: 'extraParagraph', detail: compact(p) }));
  const first = contentBearing[0];

  const { ruleLine, unmodeled: ruleLineUnmodeled } = resolveRuleLine(paragraphs, first, edge);
  // Order-corrected (#485 review): this call site's output becomes
  // user-visible cell content, so it must survive an interleaved
  // w:fldSimple/w:r sequence in true document order — the OTHER order-
  // corrected call site is header-footer-table.ts's captureTableCell, which
  // takes the same `order` side-table for its own user-visible cell content.
  // Every other runsOf call in this module (above, and inside
  // resolveRuleLine) only tests run SET membership/count, which is
  // order-independent.
  const { cells, unmodeled: cellUnmodeled } = first
    ? splitParagraphIntoCells(runsOf(first, order), known, order, mediaByRId)
    : { cells: {}, unmodeled: [] };

  return {
    region: buildRegionFromCells(cells, ruleLine),
    unmodeled: [...cellUnmodeled, ...ruleLineUnmodeled, ...extraUnmodeled],
  };
}

/**
 * Capture one header/footer part (`partXml`, the already-read text of a
 * single word/header*.xml or word/footer*.xml) into at most one
 * HeaderFooterRegion — its first content-bearing paragraph (left/center/right
 * cells) AND its first qualifying root-level table (#309, ADR-071
 * captureTablesForRegion), both merged into the same region when present —
 * plus every unsupported/unrecognized content item as a stamped, JSON-safe
 * unmodeled entry (ADR-068). `edge` selects which paragraph border
 * represents this region's rule line ('bottom' for a header, 'top' for a
 * footer). Never throws for document-content reasons — only
 * malformed-but-present part XML throws (DOCX_HEADER_FOOTER_XML_INVALID).
 *
 * `mediaByRId` (#487, OPTIONAL) is this part's own rId -> media-bytes slice
 * of header-footer-media-parts.ts's eagerly-resolved map — threaded into
 * paragraph/cell capture only. `captureTablesForRegion` is deliberately NEVER
 * given it: table-cell images stay out of scope (ADR-071 decision 4), so a
 * table cell's own drawing pre-filter (header-footer-table.ts) still always
 * produces an unmodeled entry, never a modeled `image` field.
 *
 * A run-ordinal side-table (header-footer-run-order.ts's computeRunOrder,
 * #485 review) is built once per part, from this SAME partXml, and threaded
 * into BOTH captureFromParagraphs' order-sensitive runsOf call AND
 * captureTablesForRegion (header-footer-table.ts, #485 review) so every
 * order-sensitive runsOf call in this part — paragraph cell or table cell —
 * restores true document order across an interleaved w:fldSimple/w:r
 * sequence that the grouped-mode parse above cannot preserve on its own.
 * Unlike mediaByRId (table-cell images stay out of scope, ADR-071 decision
 * 4), RunOrder is not an exclusion — table-cell fields need the same
 * correction paragraph-cell fields do.
 */
export function captureRegion(
  partXml: string,
  edge: 'top' | 'bottom',
  variant: HeaderFooterUnmodeledEntry['variant'],
  region: HeaderFooterUnmodeledEntry['region'],
  known: KnownSectionIdentity,
  mediaByRId?: ReadonlyMap<string, Uint8Array>
): RegionCaptureResult {
  const parsed = parsePartXml(partXml, region);
  const root = asRecord(parsed[partRootKey(region)]);
  if (!root) return { region: undefined, unmodeled: [] };

  const order = computeRunOrder(partXml, partRootKey(region), root, region);
  const toStamped = stamp(variant, region);
  const fromParagraphs = captureFromParagraphs(paragraphsOf(root), edge, known, order, mediaByRId);
  const tableResult = captureTablesForRegion(root, known, order);
  const mergedRegion = compact({
    ...fromParagraphs.region,
    table: tableResult.table,
  }) as HeaderFooterRegion;
  return {
    region: Object.keys(mergedRegion).length > 0 ? mergedRegion : undefined,
    unmodeled: [
      ...tableResult.unmodeled.map(toStamped),
      ...fromParagraphs.unmodeled.map(toStamped),
    ],
  };
}
