// Root-level table capture for DOCX header/footer parts (#309, ADR-071): a
// header/footer part's w:tbl is always a root-level sibling of w:p (ADR-068 —
// OOXML tables cannot nest inside a paragraph), so this scans the same
// already-parsed part root header-footer-region.ts hands it and captures the
// FIRST qualifying (non-nested, non-merged) table into HeaderFooterTable,
// mirroring ADR-068's "first paragraph wins" rule. A structurally
// unsupported table (nested w:tbl, vertical cell merge) disqualifies the
// whole table; an unsupported field or an extra paragraph inside an
// otherwise-simple cell drops only that item — both preserved as unmodeled,
// never silently lost. Per-cell field recognition reuses
// header-footer-region.ts's buildCellContent/runsOf/paragraphHasContent/
// isDrawingRun/captureBorderEdge rather than reimplementing them; cell
// paragraphs are gathered by this module's own deep collectCellParagraphs
// (w:sdt/w:ins-wrapped cell paragraphs, not just direct w:p children).
// captureTablesForRegion also takes captureRegion's per-part RunOrder
// side-table (header-footer-run-order.ts, #485 review) and threads it all
// the way to each cell's own runsOf call, so a w:fldSimple field interleaved
// between two w:r runs inside a table cell keeps true document order exactly
// like the paragraph path does — the table-cell path is not order-exempt.
// A drawing living inside any of this module's own discard paths — an extra
// (2nd+) cell paragraph, a whole disqualified table, or an extra (2nd+)
// root-level table — is additionally itemized as its own
// `unresolvedReference` when the part's own .rels file is unreadable (#505,
// #502 follow-up); imageUnmodeledEntry and the itemizeTableDiscardDrawings
// scanner both now live in header-footer-discard-drawings.ts (relocated
// from this file) alongside the paragraph-path counterpart used by
// header-footer-region.ts.

import { asRecord, compact, extractAttrStr, toArray } from './xml-utils.js';
import { collapseComplexFields } from './header-footer-field-recognition.js';
import type { KnownSectionIdentity } from './header-footer-field-recognition.js';
import {
  buildCellContent,
  captureBorderEdge,
  isDrawingRun,
  runsOf,
  paragraphHasContent,
} from './header-footer-region.js';
import type { HeaderFooterRegion, PartialUnmodeled } from './header-footer-region.js';
import type { RunOrder } from './header-footer-run-order.js';
import {
  imageUnmodeledEntry,
  itemizeTableDiscardDrawings,
} from './header-footer-discard-drawings.js';
import type { HeaderFooterPartMedia } from './header-footer-media-parts.js';

// Local indexed-access aliases (mirrors header-footer-region.ts's own
// pattern): derived structurally off HeaderFooterRegion's new `table` slot
// rather than importing ast/header-footer-schemas.ts internals
// (module-boundary rule).
export type HeaderFooterTable = NonNullable<HeaderFooterRegion['table']>;
export type HeaderFooterTableRow = HeaderFooterTable['rows'][number];
export type HeaderFooterTableCell = HeaderFooterTableRow['cells'][number];

export interface TableCaptureResult {
  readonly table: HeaderFooterTable | undefined;
  readonly unmodeled: readonly PartialUnmodeled[];
}

// fast-xml-parser renders a childless, attribute-less element (e.g. a bare
// `<w:tbl></w:tbl>` with zero rows) as the empty string '' rather than {} —
// every w:tbl/w:tr/w:tc/w:gridCol read in this module goes through this
// normalizer so a genuinely-present-but-empty element still surfaces as an
// (empty) Record, never as a falsy string that would make it silently vanish
// from a `tables[0]`-style truthiness check downstream.
function recordsOf(
  container: Record<string, unknown>,
  key: string
): readonly Record<string, unknown>[] {
  return toArray<unknown>(container[key] as readonly unknown[] | undefined).map(
    (entry) => asRecord(entry) ?? {}
  );
}

// ─── structural disqualification (ADR-071 decision 4) ──────────────────────

function allCellsOf(tbl: Record<string, unknown>): readonly Record<string, unknown>[] {
  return recordsOf(tbl, 'w:tr').flatMap((tr) => recordsOf(tr, 'w:tc'));
}

// A w:tbl nested inside a w:tc — always a root-level sibling of w:p per
// ADR-068, so any w:tbl found INSIDE a cell here, at any depth, is a genuine
// nested table. Deep scan (mirrors document.ts's collectRuns traversal)
// rather than a direct `'w:tbl' in tc` check: a nested w:tbl wrapped in a
// w:sdt content control (or any other future wrapper) sits several levels
// below tc, not as a direct property — a shallow check would miss it, drop
// the table with no unmodeled trace, and report the surrounding table as
// cleanly captured.
function containsNestedTable(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsNestedTable);
  if (node === null || typeof node !== 'object') return false;
  return Object.entries(node as Record<string, unknown>).some(
    ([key, child]) => key === 'w:tbl' || containsNestedTable(child)
  );
}

function hasNestedTable(tbl: Record<string, unknown>): boolean {
  return allCellsOf(tbl).some((tc) => containsNestedTable(tc));
}

// Vertical cell merge (w:vMerge) has no representation in
// HeaderFooterTableSchema (only columnSpan for horizontal gridSpan) —
// rendering a merge-bearing grid as if it were simple would corrupt the
// layout rather than preserve it (ADR-071 decision 4).
function hasUnsupportedMerge(tbl: Record<string, unknown>): boolean {
  return allCellsOf(tbl).some((tc) => 'w:vMerge' in (asRecord(tc['w:tcPr']) ?? {}));
}

// ─── column widths / borders (table-level, ADR-071 decision 2) ─────────────

function parsePositiveInt(str: string): number | undefined {
  const n = parseInt(str, 10);
  return isNaN(n) || n <= 0 ? undefined : n;
}

function columnWidthsOf(tbl: Record<string, unknown>): readonly number[] | undefined {
  const grid = asRecord(tbl['w:tblGrid']);
  const cols = grid ? recordsOf(grid, 'w:gridCol') : [];
  if (cols.length === 0) return undefined;
  const widths = cols.map((c) => parsePositiveInt(extractAttrStr(c, '@_w:w')));
  // Any single unreadable column width invalidates the whole hint array
  // (schema requires every entry to be a positive int) — the table itself
  // still captures without it, a documented simplification.
  return widths.every((w): w is number => w !== undefined) ? widths : undefined;
}

// A single HeaderFooterRuleLine represents all six ITableBordersOptions
// edges uniformly (ADR-071 decision 2) — captured here from w:tblBorders'
// w:top edge as the table's representative border definition, mirroring
// header-footer-region.ts's own "first wins" simplifications elsewhere in
// this capture pipeline.
function tableBordersOf(tblPr: Record<string, unknown> | undefined): HeaderFooterTable['borders'] {
  return captureBorderEdge(asRecord(tblPr?.['w:tblBorders']), 'w:top');
}

// ─── per-cell capture (ADR-071 decision 4: per-item, not whole-table) ──────

function columnSpanOf(tc: Record<string, unknown>): number | undefined {
  const gridSpan = asRecord(asRecord(tc['w:tcPr'])?.['w:gridSpan']);
  return gridSpan ? parsePositiveInt(extractAttrStr(gridSpan, '@_w:val')) : undefined;
}

// A cell's content-bearing paragraph is not always a DIRECT w:p child of the
// w:tc: content controls (w:sdt) and tracked-change wrappers (w:ins/w:del)
// wrap paragraphs exactly as they wrap runs — the same reason region capture
// deep-scans runs (header-footer-region.ts's runsOf/collectRuns) and this
// module deep-scans for nested tables (containsNestedTable). A shallow
// `tc['w:p']` read would capture a cell whose only paragraph is wrapped as
// EMPTY, with no unmodeled entry and no warning — a silent drop this pipeline
// forbids (ADR-068 criteria 3/4). This collects every w:p at any depth in
// document order, skipping property containers (w:tcPr/w:pPr/w:rPr) and never
// descending into a nested w:tbl (already disqualified upstream by
// hasNestedTable — guarded here so the collector stays correct in isolation).
// Keys collectCellParagraphs never recurses into: property containers
// (w:tcPr/w:pPr/w:rPr) carry no paragraph content, and a nested w:tbl is
// disqualified upstream — harvesting its paragraphs here would be wrong.
// A Set (not a 4-way `||`) keeps the collector under the enforced
// complexity cap of 10.
const CELL_PARAGRAPH_SKIP_KEYS: ReadonlySet<string> = new Set([
  'w:tcPr',
  'w:pPr',
  'w:rPr',
  'w:tbl',
]);

function collectCellParagraphs(node: unknown, acc: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCellParagraphs(item, acc);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (CELL_PARAGRAPH_SKIP_KEYS.has(key)) continue;
    if (key === 'w:p') {
      acc.push(
        ...toArray<Record<string, unknown>>(child as readonly Record<string, unknown>[] | undefined)
      );
      continue;
    }
    collectCellParagraphs(child, acc);
  }
}

function paragraphsInCell(tc: Record<string, unknown>): readonly Record<string, unknown>[] {
  const acc: Record<string, unknown>[] = [];
  collectCellParagraphs(tc, acc);
  return acc;
}

interface CellCaptureResult {
  readonly cell: HeaderFooterTableCell;
  readonly unmodeled: readonly PartialUnmodeled[];
}

function captureTableCell(
  tc: Record<string, unknown>,
  known: KnownSectionIdentity,
  order: RunOrder,
  partMedia?: HeaderFooterPartMedia
): CellCaptureResult {
  const contentBearing = paragraphsInCell(tc).filter((p) => paragraphHasContent(runsOf(p)));
  const extraParagraphs = contentBearing.slice(1);
  const extraUnmodeled: readonly PartialUnmodeled[] = extraParagraphs.map(
    (p): PartialUnmodeled => ({ kind: 'extraParagraph', detail: compact(p) })
  );
  // #505: a drawing living inside one of these extra (2nd+) cell paragraphs
  // is still preserved verbatim by extraUnmodeled above (never lost) but is
  // ALSO itemized here as its own unresolvedReference when the part's own
  // .rels file is unreadable — UNGATED (INV-3), matching this cell's own
  // FIRST-paragraph drawing handling below (imageUnmodeledEntry), which
  // never gates on descriptor validity either (ADR-071 decision 4:
  // table-cell images are out of scope regardless).
  const discardedDrawingUnmodeled = itemizeTableDiscardDrawings(extraParagraphs, partMedia);
  const columnSpan = columnSpanOf(tc);
  const first = contentBearing[0];
  if (!first) {
    return {
      cell: compact({ columnSpan }) as HeaderFooterTableCell,
      unmodeled: [...extraUnmodeled, ...discardedDrawingUnmodeled],
    };
  }

  // Table-cell images stay OUT OF SCOPE (#487, ADR-071 decision 4, source-
  // confirmed against src/generator/header-footer-tables.ts: buildTable never
  // renders image content inside a cell). This pre-filter runs BEFORE
  // buildCellContent, so buildCellContent's own drawing branch (#487,
  // header-footer-region.ts) is never reached from this call site — a
  // table-cell drawing run always becomes an unmodeled entry here (image, or
  // #502's unresolvedReference for a damaged part), never a modeled `image`
  // field. buildCellContent is deliberately called WITHOUT a partMedia
  // argument for the same reason.
  //
  // `order` (#485 review, CRITICAL) is threaded from captureRegion's SAME
  // per-part RunOrder side-table the paragraph path uses (captureFromParagraphs'
  // own runsOf(first, order) call in header-footer-region.ts) — this cell's
  // content is exactly as user-visible as a paragraph cell's, so it needs the
  // exact same order correction for a w:fldSimple field interleaved between
  // two w:r runs, not just the run-SET membership checks the rest of this
  // module's runsOf calls (paragraphsInCell filtering) rely on.
  const collapsed = collapseComplexFields(runsOf(first, order), order);
  const imageUnmodeled: readonly PartialUnmodeled[] = collapsed
    .filter(isDrawingRun)
    .map((run) => imageUnmodeledEntry(run, partMedia));
  const built = buildCellContent(
    collapsed.filter((r) => !isDrawingRun(r)),
    known
  );
  const cell = compact({
    content: built.content.length > 0 ? built.content : undefined,
    columnSpan,
    style: built.style,
  }) as HeaderFooterTableCell;
  return {
    cell,
    unmodeled: [
      ...imageUnmodeled,
      ...built.unmodeled,
      ...extraUnmodeled,
      ...discardedDrawingUnmodeled,
    ],
  };
}

interface RowCaptureResult {
  readonly row: HeaderFooterTableRow;
  readonly unmodeled: readonly PartialUnmodeled[];
}

function captureTableRow(
  tr: Record<string, unknown>,
  known: KnownSectionIdentity,
  order: RunOrder,
  partMedia?: HeaderFooterPartMedia
): RowCaptureResult {
  const built = recordsOf(tr, 'w:tc').map((tc) => captureTableCell(tc, known, order, partMedia));
  return { row: { cells: built.map((b) => b.cell) }, unmodeled: built.flatMap((b) => b.unmodeled) };
}

// ─── single-table assembly ───────────────────────────────────────────────────

function captureTable(
  tbl: Record<string, unknown>,
  known: KnownSectionIdentity,
  order: RunOrder,
  partMedia?: HeaderFooterPartMedia
): TableCaptureResult {
  const rows = recordsOf(tbl, 'w:tr');
  if (rows.length === 0 || hasNestedTable(tbl) || hasUnsupportedMerge(tbl)) {
    // #505: the whole disqualified table is still preserved verbatim below
    // (never lost) — but any drawing living anywhere inside it (at any
    // depth, including inside a disqualifying nested w:tbl) is ALSO
    // itemized as its own unresolvedReference when the part's own .rels
    // file is unreadable, UNGATED (INV-3), matching this same table's own
    // per-cell drawing handling when it IS structurally capturable.
    const discardedDrawingUnmodeled = itemizeTableDiscardDrawings([tbl], partMedia);
    return {
      table: undefined,
      unmodeled: [{ kind: 'table', detail: compact(tbl) }, ...discardedDrawingUnmodeled],
    };
  }
  const built = rows.map((tr) => captureTableRow(tr, known, order, partMedia));
  const table = compact({
    rows: built.map((b) => b.row),
    columnWidths: columnWidthsOf(tbl),
    borders: tableBordersOf(asRecord(tbl['w:tblPr'])),
  }) as HeaderFooterTable;
  return { table, unmodeled: built.flatMap((b) => b.unmodeled) };
}

/**
 * Capture at most one HeaderFooterTable from a header/footer part's
 * root-level w:tbl children. Only the FIRST root-level table is ever a
 * capture candidate (ADR-071 decision 5, mirroring ADR-068's "first
 * paragraph wins"); every other root-level table — whether it precedes or
 * follows the captured one, and regardless of its own structural validity —
 * is preserved whole as an unmodeled `{ kind: 'table' }` entry, never merged
 * into or overwriting the captured table.
 *
 * `order` (#485 review, CRITICAL) is header-footer-run-order.ts's per-part
 * RunOrder side-table — the SAME one captureRegion computes once from this
 * SAME partXml/root and threads into its own paragraph-cell capture
 * (header-footer-region.ts's captureFromParagraphs). Table-cell content is
 * captured via this same module's runsOf/collectRunsAndFields traversal, so
 * it is equally vulnerable to fast-xml-parser's grouped-mode sibling-merge
 * reordering when a w:fldSimple field sits between two w:r runs inside one
 * cell — this side-table restores true document order there too, mirroring
 * (not diverging from) the paragraph path. RunOrder is not an out-of-scope
 * exclusion the way `partMedia` is — every table-cell field capture needs it.
 *
 * `partMedia` (#502, OPTIONAL) is the SAME per-part HeaderFooterPartMedia
 * captureRegion resolves for its own paragraph-cell capture — passed here
 * ONLY so a `relsUnreadable` part can be attributed by `partPath` in each
 * qualifying cell's unmodeled entry (imageUnmodeledEntry, captureTableCell).
 * Table-cell images stay out of scope regardless (ADR-071 decision 4): a
 * `resolved` partMedia is never used to look up cell-image bytes here,
 * mirroring buildCellContent's own table-cell call site, which is never
 * given `partMedia` at all.
 */
export function captureTablesForRegion(
  root: Record<string, unknown>,
  known: KnownSectionIdentity,
  order: RunOrder,
  partMedia?: HeaderFooterPartMedia
): TableCaptureResult {
  const tables = recordsOf(root, 'w:tbl');
  const first = tables[0];
  if (!first) return { table: undefined, unmodeled: [] };

  const captured = captureTable(first, known, order, partMedia);
  const extraTables = tables.slice(1);
  const extraUnmodeled: readonly PartialUnmodeled[] = extraTables.map(
    (tbl): PartialUnmodeled => ({ kind: 'table', detail: compact(tbl) })
  );
  // #505: each EXTRA root-level table is still preserved verbatim above
  // (never lost) — but any drawing living anywhere inside one (at any depth)
  // is ALSO itemized as its own unresolvedReference when the part's own
  // .rels file is unreadable, UNGATED (INV-3), matching this same module's
  // own per-cell and disqualified-whole-table drawing handling above.
  const discardedDrawingUnmodeled = itemizeTableDiscardDrawings(extraTables, partMedia);
  return {
    table: captured.table,
    unmodeled: [...captured.unmodeled, ...extraUnmodeled, ...discardedDrawingUnmodeled],
  };
}
