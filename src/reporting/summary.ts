import type {
  BaselineLens,
  ComparisonMatrix,
  ComparisonMatrixRow,
  ComparisonSummary,
  ComparisonSummaryColumn,
} from './types.js';

const presentCount = (row: ComparisonMatrixRow): number =>
  row.cells.filter((c) => c.present).length;

/** A row is identical iff present in every column and all present texts are equal. */
function isIdentical(row: ComparisonMatrixRow, columnCount: number): boolean {
  const texts = row.cells.flatMap((c) => (c.present ? [c.text] : []));
  return texts.length === columnCount && texts.every((t) => t === texts[0]);
}

function summarizeColumn(matrix: ComparisonMatrix, index: number): ComparisonSummaryColumn {
  const specId = matrix.columns[index]?.specId ?? '';
  const present = matrix.rows.filter((r) => r.cells[index]?.present).length;
  const onlyIn = matrix.rows.filter(
    (r) => presentCount(r) === 1 && r.cells[index]?.present === true
  ).length;
  return { specId, present, onlyIn };
}

/** Grounded rollup computed over the FULL matrix (never the filtered view), so an
 *  agent can cite totals without paging every row (ADR-053). */
export function summarize(matrix: ComparisonMatrix): ComparisonSummary {
  const columnCount = matrix.columns.length;
  const identical = matrix.rows.filter((r) => isIdentical(r, columnCount)).length;
  return {
    rows: matrix.rows.length,
    aligned: matrix.rows.filter((r) => presentCount(r) >= 2).length,
    identical,
    differing: matrix.rows.length - identical,
    columns: matrix.columns.map((_c, i) => summarizeColumn(matrix, i)),
  };
}

/** Trim matrix rows (and any baseline-lens rows) to the non-identical set. Returns
 *  new objects; the summary is computed separately over the full matrix. */
export function filterToDifferences(
  matrix: ComparisonMatrix,
  baseline?: BaselineLens
): { readonly matrix: ComparisonMatrix; readonly baseline?: BaselineLens } {
  const columnCount = matrix.columns.length;
  const kept = new Set(
    matrix.rows.filter((r) => !isIdentical(r, columnCount)).map((r) => r.originId)
  );
  const filteredMatrix: ComparisonMatrix = {
    columns: matrix.columns,
    rows: matrix.rows.filter((r) => kept.has(r.originId)),
  };
  if (baseline === undefined) return { matrix: filteredMatrix };
  return {
    matrix: filteredMatrix,
    baseline: { specId: baseline.specId, rows: baseline.rows.filter((r) => kept.has(r.originId)) },
  };
}
