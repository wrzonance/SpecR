// Per-region paragraph capture for DOCX header/footer parts (#306, ADR-068):
// reads a single word/header*.xml or word/footer*.xml part and captures its
// first content-bearing paragraph into a HeaderFooterRegion ({left, center,
// right} cells split on tab boundaries, plus a rule-line border passthrough).
// Table detection, tab-boundary overflow, and any second content-bearing
// paragraph are preserved as unmodeled entries rather than silently dropped
// (acceptance criteria 3/4). Field-code/text recognition itself lives in
// header-footer-field-recognition.ts; relationship/section-property
// discovery lives in header-footer-relationships.ts.

import { ParserError } from '../error.js';
import {
  asRecord,
  compact,
  createDocumentXmlParser,
  extractAttrStr,
  toArray,
} from './xml-utils.js';
import { collectRuns } from './document.js';
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
// than threaded through every helper.
type PartialUnmodeled = Omit<HeaderFooterUnmodeledEntry, 'variant' | 'region'>;

function stamp(
  variant: HeaderFooterUnmodeledEntry['variant'],
  region: HeaderFooterUnmodeledEntry['region']
): (partial: PartialUnmodeled) => HeaderFooterUnmodeledEntry {
  return (partial) => ({ variant, region, ...partial });
}

// Own instance, scoped to header/footer part vocabulary (w:hdr/w:ftr root,
// w:p/w:r/w:tbl as the only repeatable wrapper tags this scan needs) —
// shares createDocumentXmlParser's #22/#120-safe base config (xml-utils).
const partParser = createDocumentXmlParser(['w:p', 'w:r', 'w:tbl']);

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

// ─── table detection (root-level scan, ADR-068) ─────────────────────────────

// OOXML tables (w:tbl) cannot nest inside a paragraph (w:p) — a header/footer
// part's w:tbl is always a root-level sibling of w:p, never a descendant.
// Scanning the part root's direct children (never inside a paragraph's run
// sequence) is a structural fact, not a heuristic (ADR-068).
function findTables(root: Record<string, unknown>): readonly Record<string, unknown>[] {
  return toArray<Record<string, unknown>>(
    root['w:tbl'] as readonly Record<string, unknown>[] | undefined
  );
}

// ─── paragraph selection ────────────────────────────────────────────────────

function paragraphsOf(root: Record<string, unknown>): readonly Record<string, unknown>[] {
  return toArray<Record<string, unknown>>(
    root['w:p'] as readonly Record<string, unknown>[] | undefined
  );
}

// Deep scan (document.ts's collectRuns, reused here #306 review): a header/footer
// paragraph's runs can nest inside w:hyperlink, tracked-change wrappers (w:ins/w:del),
// or a w:sdt content control — the exact same wrapper vocabulary the main body parser
// already handles. A direct-children-only scan silently dropped any wrapped header/
// footer text with no unmodeled entry and no warning; this makes wrapped content
// visible to capture the same way it already is for ordinary body paragraphs.
function runsOf(paragraph: Record<string, unknown>): readonly Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  collectRuns(paragraph, runs);
  return runs;
}

function paragraphHasContent(runs: readonly Record<string, unknown>[]): boolean {
  return runs.some(
    (r) => 'w:t' in r || 'w:fldChar' in r || 'w:instrText' in r || 'w:drawing' in r || 'w:pict' in r
  );
}

// ─── rule line (paragraph border passthrough, ADR-068) ─────────────────────

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
 * Read the first content-bearing paragraph's border on `edge` ('bottom' for
 * a header's rule line beneath its text, 'top' for a footer's rule line
 * above it) as a verbatim style passthrough (ADR-068): w:val -> style, w:sz
 * -> widthTwips, w:color -> color. `w:val="nil"`/`"none"` explicitly
 * suppresses the border — treated as no rule line at all, not `enabled:
 * false`.
 */
function captureRuleLine(
  pPr: Record<string, unknown> | undefined,
  edge: 'top' | 'bottom'
): HeaderFooterRuleLine | undefined {
  const pBdr = asRecord(pPr?.['w:pBdr']);
  const border = asRecord(pBdr?.[`w:${edge}`]);
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
// only); a recognized field marker flushes the buffer first, then
// contributes its own field or unmodeled entry.
function buildCellContent(
  pieces: readonly Record<string, unknown>[],
  known: KnownSectionIdentity
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
    if (!isCollapsedFieldRun(piece)) {
      buffer += extractTextLikeValue(piece['w:t']);
      continue;
    }
    flushBuffer();
    const resolved = resolveFieldMarker(piece.__collapsedField);
    if (resolved.kind === 'field') content.push(resolved.field);
    else unmodeled.push(resolved.entry);
  }
  flushBuffer();
  return { content, unmodeled, style: firstRunStyle(pieces) };
}

// ─── tab-boundary cell split (ADR-068: KNOWN AMBIGUITY at 3+ tabs) ─────────

function isDrawingRun(run: Record<string, unknown>): boolean {
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
  known: KnownSectionIdentity
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
    const built = buildCellContent(segment, known);
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

function splitParagraphIntoCells(
  runs: readonly Record<string, unknown>[],
  known: KnownSectionIdentity
): {
  readonly cells: Partial<Record<CellKey, HeaderFooterCell>>;
  readonly unmodeled: readonly PartialUnmodeled[];
} {
  const collapsed = collapseComplexFields(runs);
  const imageUnmodeled: readonly PartialUnmodeled[] = collapsed
    .filter(isDrawingRun)
    .map((run): PartialUnmodeled => ({ kind: 'image', detail: compact(run) }));
  const segments = splitOnTabs(collapsed.filter((r) => !isDrawingRun(r)));
  const assigned = assignSegmentsToCells(segments, known);
  return { cells: assigned.cells, unmodeled: [...imageUnmodeled, ...assigned.unmodeled] };
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
// first paragraph's capture (ADR-068).
function captureFromParagraphs(
  paragraphs: readonly Record<string, unknown>[],
  edge: 'top' | 'bottom',
  known: KnownSectionIdentity
): {
  readonly region: HeaderFooterRegion | undefined;
  readonly unmodeled: readonly PartialUnmodeled[];
} {
  const contentBearing = paragraphs.filter((p) => paragraphHasContent(runsOf(p)));
  const extraUnmodeled: readonly PartialUnmodeled[] = contentBearing
    .slice(1)
    .map((p): PartialUnmodeled => ({ kind: 'extraParagraph', detail: compact(p) }));
  const first = contentBearing[0];
  if (!first) return { region: undefined, unmodeled: extraUnmodeled };

  const ruleLine = captureRuleLine(asRecord(first['w:pPr']), edge);
  const { cells, unmodeled: cellUnmodeled } = splitParagraphIntoCells(runsOf(first), known);
  return {
    region: buildRegionFromCells(cells, ruleLine),
    unmodeled: [...cellUnmodeled, ...extraUnmodeled],
  };
}

/**
 * Capture one header/footer part (`partXml`, the already-read text of a
 * single word/header*.xml or word/footer*.xml) into at most one
 * HeaderFooterRegion, plus every unsupported/unrecognized content item as a
 * stamped, JSON-safe unmodeled entry (ADR-068). `edge` selects which
 * paragraph border represents this region's rule line ('bottom' for a
 * header, 'top' for a footer). Never throws for document-content reasons —
 * only malformed-but-present part XML throws (DOCX_HEADER_FOOTER_XML_INVALID).
 */
export function captureRegion(
  partXml: string,
  edge: 'top' | 'bottom',
  variant: HeaderFooterUnmodeledEntry['variant'],
  region: HeaderFooterUnmodeledEntry['region'],
  known: KnownSectionIdentity
): RegionCaptureResult {
  const parsed = parsePartXml(partXml, region);
  const root = asRecord(parsed[partRootKey(region)]);
  if (!root) return { region: undefined, unmodeled: [] };

  const toStamped = stamp(variant, region);
  const tableUnmodeled = findTables(root).map((tbl) =>
    toStamped({ kind: 'table', detail: compact(tbl) })
  );
  const fromParagraphs = captureFromParagraphs(paragraphsOf(root), edge, known);
  return {
    region: fromParagraphs.region,
    unmodeled: [...tableUnmodeled, ...fromParagraphs.unmodeled.map(toStamped)],
  };
}
