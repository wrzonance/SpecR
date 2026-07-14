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
// header-footer-region.ts's buildCellContent/paragraphsOf/runsOf/
// paragraphHasContent/isDrawingRun/captureBorderEdge rather than
// reimplementing them.

import { asRecord, compact, extractAttrStr, toArray } from './xml-utils.js';
import { collapseComplexFields } from './header-footer-field-recognition.js';
import type { KnownSectionIdentity } from './header-footer-field-recognition.js';
import {
  buildCellContent,
  captureBorderEdge,
  isDrawingRun,
  paragraphsOf,
  runsOf,
  paragraphHasContent,
} from './header-footer-region.js';
import type { HeaderFooterRegion, PartialUnmodeled } from './header-footer-region.js';

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

interface CellCaptureResult {
  readonly cell: HeaderFooterTableCell;
  readonly unmodeled: readonly PartialUnmodeled[];
}

function captureTableCell(
  tc: Record<string, unknown>,
  known: KnownSectionIdentity
): CellCaptureResult {
  const contentBearing = paragraphsOf(tc).filter((p) => paragraphHasContent(runsOf(p)));
  const extraUnmodeled: readonly PartialUnmodeled[] = contentBearing
    .slice(1)
    .map((p): PartialUnmodeled => ({ kind: 'extraParagraph', detail: compact(p) }));
  const columnSpan = columnSpanOf(tc);
  const first = contentBearing[0];
  if (!first) {
    return { cell: compact({ columnSpan }) as HeaderFooterTableCell, unmodeled: extraUnmodeled };
  }

  const collapsed = collapseComplexFields(runsOf(first));
  const imageUnmodeled: readonly PartialUnmodeled[] = collapsed
    .filter(isDrawingRun)
    .map((run): PartialUnmodeled => ({ kind: 'image', detail: compact(run) }));
  const built = buildCellContent(
    collapsed.filter((r) => !isDrawingRun(r)),
    known
  );
  const cell = compact({
    content: built.content.length > 0 ? built.content : undefined,
    columnSpan,
    style: built.style,
  }) as HeaderFooterTableCell;
  return { cell, unmodeled: [...imageUnmodeled, ...built.unmodeled, ...extraUnmodeled] };
}

interface RowCaptureResult {
  readonly row: HeaderFooterTableRow;
  readonly unmodeled: readonly PartialUnmodeled[];
}

function captureTableRow(
  tr: Record<string, unknown>,
  known: KnownSectionIdentity
): RowCaptureResult {
  const built = recordsOf(tr, 'w:tc').map((tc) => captureTableCell(tc, known));
  return { row: { cells: built.map((b) => b.cell) }, unmodeled: built.flatMap((b) => b.unmodeled) };
}

// ─── single-table assembly ───────────────────────────────────────────────────

function captureTable(
  tbl: Record<string, unknown>,
  known: KnownSectionIdentity
): TableCaptureResult {
  const rows = recordsOf(tbl, 'w:tr');
  if (rows.length === 0 || hasNestedTable(tbl) || hasUnsupportedMerge(tbl)) {
    return { table: undefined, unmodeled: [{ kind: 'table', detail: compact(tbl) }] };
  }
  const built = rows.map((tr) => captureTableRow(tr, known));
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
 */
export function captureTablesForRegion(
  root: Record<string, unknown>,
  known: KnownSectionIdentity
): TableCaptureResult {
  const tables = recordsOf(root, 'w:tbl');
  const first = tables[0];
  if (!first) return { table: undefined, unmodeled: [] };

  const captured = captureTable(first, known);
  const extraUnmodeled: readonly PartialUnmodeled[] = tables
    .slice(1)
    .map((tbl): PartialUnmodeled => ({ kind: 'table', detail: compact(tbl) }));
  return { table: captured.table, unmodeled: [...captured.unmodeled, ...extraUnmodeled] };
}
