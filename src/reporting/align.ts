import { ReportingError } from './error.js';
import type {
  AlignSource,
  BaselineLens,
  BaselineLensRow,
  CellState,
  ComparisonCell,
  ComparisonColumn,
  ComparisonMatrix,
  ComparisonMatrixRow,
  ComparisonParagraph,
} from './types.js';

/** The alignment key. One COALESCE covers both slice comparisons (ADR-047):
 *  a cloned paragraph aligns on its master origin; a NULL-origin paragraph
 *  (added-after-clone or origin-deleted, or a root master) keys on its own id
 *  and surfaces as only-in-X. */
const keyOf = (p: ComparisonParagraph): string => p.originParagraphId ?? p.id;

/** First-wins on collision. Rows arrive pre-sorted by (position, id) so the
 *  winner is deterministic.
 *  // KNOWN AMBIGUITY: two paragraphs in one source resolving to the same origin
 *  // — first by (position, id) wins; the loser is dropped from that column. */
function buildSourceMap(
  rows: readonly ComparisonParagraph[]
): ReadonlyMap<string, ComparisonParagraph> {
  const map = new Map<string, ComparisonParagraph>();
  for (const row of rows) {
    const k = keyOf(row);
    if (!map.has(k)) map.set(k, row);
  }
  return map;
}

/** The deterministic row order: first-occurrence sweep, left-to-right across
 *  sources and top-to-bottom within each source's (position, id) order. */
function sweepOrderedKeys(sources: readonly AlignSource[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const source of sources) {
    for (const row of source.rows) {
      const k = keyOf(row);
      if (!seen.has(k)) {
        seen.add(k);
        ordered.push(k);
      }
    }
  }
  return ordered;
}

function cellFor(map: ReadonlyMap<string, ComparisonParagraph>, key: string): ComparisonCell {
  const p = map.get(key);
  if (p === undefined) return { present: false };
  return { present: true, specId: p.specId, paragraphUuid: p.id, text: p.text };
}

/** Build the symmetric matrix; when `options.baseline` is set, project a baseline
 *  lens over it (a projection, not a second alignment pass — ADR-047). */
export function alignTrees(
  sources: readonly AlignSource[],
  options?: { readonly baseline?: string }
): { readonly matrix: ComparisonMatrix; readonly baseline?: BaselineLens } {
  const columns: readonly ComparisonColumn[] = sources.map((s) => s.column);
  const maps = sources.map((s) => buildSourceMap(s.rows));
  const orderedKeys = sweepOrderedKeys(sources);
  const rows: readonly ComparisonMatrixRow[] = orderedKeys.map((key) => ({
    originId: key,
    cells: maps.map((m) => cellFor(m, key)),
  }));
  const matrix: ComparisonMatrix = { columns, rows };
  const baseline = options?.baseline;
  if (baseline === undefined) return { matrix };
  return { matrix, baseline: projectBaseline(matrix, baseline) };
}

function classifyState(
  base: ComparisonCell,
  cell: ComparisonCell,
  isBaselineColumn: boolean
): CellState {
  if (isBaselineColumn) return 'baseline';
  if (!base.present && !cell.present) return 'absent';
  if (!base.present) return 'added';
  if (!cell.present) return 'removed';
  return base.text === cell.text ? 'unchanged' : 'modified';
}

function lensRow(row: ComparisonMatrixRow, baselineIndex: number): BaselineLensRow {
  const base = row.cells[baselineIndex];
  if (base === undefined) {
    throw new ReportingError('malformed matrix: baseline column cell missing');
  }
  const states = row.cells.map((cell, ci) => classifyState(base, cell, ci === baselineIndex));
  return { originId: row.originId, states };
}

/** Reframe every cell relative to one column. Introduces no new specIds/UUIDs. */
export function projectBaseline(matrix: ComparisonMatrix, baselineSpecId: string): BaselineLens {
  const baselineIndex = matrix.columns.findIndex((c) => c.specId === baselineSpecId);
  if (baselineIndex === -1) {
    throw new ReportingError(`baseline spec ${baselineSpecId} is not a column in the comparison`);
  }
  const rows = matrix.rows.map((row) => lensRow(row, baselineIndex));
  return { specId: baselineSpecId, rows };
}
