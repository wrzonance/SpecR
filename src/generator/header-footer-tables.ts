// src/generator/header-footer-tables.ts
// Header/footer table (grid) rendering (#309, ADR-071). Turns an AST
// `region.table` into a real docx `Table`, plus the warnings a table
// carrying image-field content produces — sitting alongside the paragraph
// (left/center/right) rendering in `header-footer-regions.ts` without
// growing that file past the repo's 400-line cap.
//
// Cell content is rendered through `renderFieldRun` ONLY, never
// `renderImageRun` — table cells structurally cannot carry an `ImageRun`
// (ADR-071 decision 4: "no images in table cells" is enforced here, at
// render time, not by a second field schema). An image field inside a
// table cell instead produces zero rendered runs plus an explicit warning
// (`tableWarnings`), matching the "warned, never silently dropped" posture
// `header-footer-images.ts` uses for other unrenderable image cases.

import { Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import type { ITableBordersOptions } from 'docx';
import {
  cascadeStyle,
  headerFooterRunOptions,
  renderFieldRun,
  type HeaderFooterField,
  type HeaderFooterFieldContext,
  type HeaderFooterVisualStyle,
} from './header-footer-fields.js';
import { imageFieldHasContent } from './header-footer-images.js';
import { ruleLineBorder, type HeaderFooterRegion } from './header-footer-regions.js';

// Local indexed-access aliases (mirrors header-footer-fields.ts's and
// header-footer-regions.ts's own pattern, and the parser's
// src/parser/docx/header-footer-table.ts): derived structurally off
// `HeaderFooterRegion`'s `table` slot rather than importing
// `ast/header-footer-schemas.ts` internals (module-boundary rule).
export type HeaderFooterTable = NonNullable<HeaderFooterRegion['table']>;
export type HeaderFooterTableRow = HeaderFooterTable['rows'][number];
export type HeaderFooterTableCell = HeaderFooterTableRow['cells'][number];

/**
 * One table cell's fields rendered to `TextRun`s only, interleaving
 * `cell.separator` (default a single space) between entries that actually
 * resolve to output — the same separator posture as
 * `header-footer-fields.ts`'s `renderCellRuns`, but deliberately NOT reused
 * from there: `renderCellRuns` routes `kind: 'image'` fields through
 * `renderImageRun` (via `renderFieldRunChild`), which is exactly the
 * behavior table cells must never exhibit. Calling `renderFieldRun`
 * directly for every field — image fields included — means an image field
 * always resolves to `[]` here (see `FIELD_RESOLVERS.image` in
 * header-footer-fields.ts), so images are excluded structurally, not by a
 * conditional. `[]` for an absent/empty cell.
 */
function tableCellRuns(
  cell: HeaderFooterTableCell,
  ctx: HeaderFooterFieldContext,
  style: HeaderFooterVisualStyle | undefined
): readonly TextRun[] {
  if (cell.content === undefined || cell.content.length === 0) return [];
  const separatorOptions = headerFooterRunOptions(style);
  const separator = cell.separator ?? ' ';
  const runs: TextRun[] = [];
  let hasRenderedField = false;
  for (const field of cell.content) {
    const fieldRuns = renderFieldRun(field, ctx, style);
    if (fieldRuns.length === 0) continue;
    if (hasRenderedField) runs.push(new TextRun({ text: separator, ...separatorOptions }));
    runs.push(...fieldRuns);
    hasRenderedField = true;
  }
  return runs;
}

/**
 * One `TableCell`: a single `Paragraph` of `tableCellRuns` output (a `w:tc`
 * needs at least one block-level child even when it renders no text — an
 * empty `Paragraph` still serializes a valid, if visually blank, cell), plus
 * `columnSpan` when the AST cell declares one (`w:gridSpan`).
 */
function buildTableCell(
  cell: HeaderFooterTableCell,
  ctx: HeaderFooterFieldContext,
  inheritedStyle: HeaderFooterVisualStyle | undefined
): TableCell {
  const style = cascadeStyle(cell.style, inheritedStyle);
  const paragraph = new Paragraph({ children: tableCellRuns(cell, ctx, style) });
  return new TableCell({
    children: [paragraph],
    ...(cell.columnSpan !== undefined ? { columnSpan: cell.columnSpan } : {}),
  });
}

/** One `TableRow`: `row.cells` rendered in order via `buildTableCell`. */
function buildTableRow(
  row: HeaderFooterTableRow,
  ctx: HeaderFooterFieldContext,
  inheritedStyle: HeaderFooterVisualStyle | undefined
): TableRow {
  return new TableRow({
    children: row.cells.map((cell) => buildTableCell(cell, ctx, inheritedStyle)),
  });
}

/**
 * `table.borders` (a single `HeaderFooterRuleLine`, ADR-071 decision 2)
 * applied UNIFORMLY to all six `ITableBordersOptions` edges via the same
 * `ruleLineBorder` helper `header-footer-regions.ts` uses for paragraph
 * rule lines — verified against real docx `Packer` output: a real
 * `<w:tblBorders>` with all six children (`top`/`bottom`/`left`/`right`/
 * `insideH`/`insideV`) serializes correctly. `undefined` when `borders` is
 * absent or not explicitly `enabled: true` (mirrors `ruleLineBorder`'s own
 * gate).
 */
function tableBordersOption(
  borders: HeaderFooterTable['borders']
): ITableBordersOptions | undefined {
  const border = ruleLineBorder(borders);
  if (border === undefined) return undefined;
  return {
    top: border,
    bottom: border,
    left: border,
    right: border,
    insideHorizontal: border,
    insideVertical: border,
  };
}

/**
 * Render one `region.table` (#309) into a docx `Table`, or `undefined` when
 * `table` is absent. `inheritedStyle` is passed straight through to every
 * row/cell as the cascade's least-specific layer — NOT re-cascaded here: the
 * caller (`buildRegionChildren`, header-footer-regions.ts) already cascades
 * `region.style` with the composition/variant style once before calling
 * this, so cascading a second time at this boundary would be a redundant
 * no-op wrapper around `cascadeStyle`.
 */
export function buildTable(
  table: HeaderFooterTable | undefined,
  inheritedStyle: HeaderFooterVisualStyle | undefined,
  ctx: HeaderFooterFieldContext
): Table | undefined {
  if (table === undefined) return undefined;
  const borders = tableBordersOption(table.borders);
  return new Table({
    rows: table.rows.map((row) => buildTableRow(row, ctx, inheritedStyle)),
    ...(table.columnWidths !== undefined ? { columnWidths: table.columnWidths } : {}),
    ...(borders !== undefined ? { borders } : {}),
  });
}

/**
 * `undefined` when `field` carries no renderable image content; a warning
 * otherwise — reusing `imageFieldHasContent` (header-footer-images.ts) so
 * this never drifts from that module's own "is this actually an image with
 * data" gate. `location` is already the fully-qualified row/cell path (see
 * `tableCellWarnings`).
 */
function tableCellImageWarning(field: HeaderFooterField, location: string): string | undefined {
  if (!imageFieldHasContent(field)) return undefined;
  return `${location}: image fields are not rendered inside table cells and will be skipped`;
}

/** Every image-field warning `cell` produces, each prefixed with `location`. */
function tableCellWarnings(
  cell: HeaderFooterTableCell,
  location: string,
  rowIndex: number,
  cellIndex: number
): readonly string[] {
  if (cell.content === undefined) return [];
  const cellLocation = `${location}.row[${rowIndex}].cell[${cellIndex}]`;
  return cell.content
    .map((field) => tableCellImageWarning(field, cellLocation))
    .filter((warning): warning is string => warning !== undefined);
}

/** Every image-field warning across `row`'s cells. */
function tableRowWarnings(
  row: HeaderFooterTableRow,
  location: string,
  rowIndex: number
): readonly string[] {
  return row.cells.flatMap((cell, cellIndex) =>
    tableCellWarnings(cell, location, rowIndex, cellIndex)
  );
}

/**
 * Every image-field warning across `table`'s rows/cells (#309), each
 * prefixed with `location` plus the row/cell path (e.g.
 * `"header.table.row[0].cell[1]"`). `[]` for an undefined table or a table
 * whose cells carry no image fields.
 */
export function tableWarnings(
  table: HeaderFooterTable | undefined,
  location: string
): readonly string[] {
  if (table === undefined) return [];
  return table.rows.flatMap((row, rowIndex) =>
    tableRowWarnings(row, `${location}.table`, rowIndex)
  );
}
