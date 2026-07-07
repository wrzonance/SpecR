import { ReportingError } from './error.js';
import { computeStructuralKeys } from './structure.js';
import type {
  AlignmentMode,
  AlignmentRequest,
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

/** The per-row alignment key: two rows in different sources align iff their keys
 *  match. `origin` and `structure` keyers below produce comparable keys. */
type Keyer = (p: ComparisonParagraph) => string;

/** Origin keyer (ADR-047). One COALESCE covers both slice comparisons: a cloned
 *  paragraph aligns on its master origin; a NULL-origin paragraph (added-after-
 *  clone or origin-deleted, or a root master) keys on its own id and surfaces as
 *  only-in-X. */
const originKeyOf: Keyer = (p) => p.originParagraphId ?? p.id;

/** True iff any origin key occurs in ≥2 distinct sources — i.e. the pair descends
 *  from a shared master (project↔project) or is project↔its-own-master. Drives the
 *  `auto` fallback: no cross-source origin overlap → independently-ingested. */
function sharesCrossSourceOrigin(sources: readonly AlignSource[]): boolean {
  const firstSeenIn = new Map<string, number>();
  for (let i = 0; i < sources.length; i += 1) {
    for (const row of sources[i]?.rows ?? []) {
      const k = originKeyOf(row);
      const seen = firstSeenIn.get(k);
      if (seen !== undefined && seen !== i) return true;
      if (seen === undefined) firstSeenIn.set(k, i);
    }
  }
  return false;
}

/** True iff every source is the same CSI section — the precondition for a meaningful
 *  structural fallback (ADR-053 targets independently-ingested specs of the SAME
 *  section). Unrelated sections share structural addresses (both have a
 *  `part:0|article:0`) but nothing semantic, so `auto` must not pair them. */
function sourcesShareSection(sources: readonly AlignSource[]): boolean {
  return new Set(sources.map((s) => s.column.section)).size <= 1;
}

function resolveAlignment(
  sources: readonly AlignSource[],
  requested: AlignmentRequest
): AlignmentMode {
  if (requested !== 'auto') return requested;
  if (sharesCrossSourceOrigin(sources)) return 'origin';
  // No shared origin: fall back to structure only for same-section peers. Different
  // sections stay on origin (→ all only-in rows), never falsely paired by address.
  return sourcesShareSection(sources) ? 'structure' : 'origin';
}

/** Structural keyer (ADR-053) over ALL sources at once — paragraph ids are
 *  globally unique, and identical structural addresses across sources are exactly
 *  what aligns them. A row with no computed address falls back to its own id. */
function structuralKeyer(sources: readonly AlignSource[]): Keyer {
  const merged = new Map<string, string>();
  for (const source of sources) {
    for (const [id, address] of computeStructuralKeys(source.rows)) merged.set(id, address);
  }
  return (p) => merged.get(p.id) ?? p.id;
}

function keyerFor(sources: readonly AlignSource[], mode: AlignmentMode): Keyer {
  return mode === 'origin' ? originKeyOf : structuralKeyer(sources);
}

/** First-wins on collision. Rows arrive pre-sorted by (position, id) so the
 *  winner is deterministic.
 *  // KNOWN AMBIGUITY: two paragraphs in one source resolving to the same key
 *  // — first by (position, id) wins; the loser is dropped from that column. */
function buildSourceMap(
  rows: readonly ComparisonParagraph[],
  keyOf: Keyer
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
function sweepOrderedKeys(sources: readonly AlignSource[], keyOf: Keyer): readonly string[] {
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

/** Build the symmetric matrix. `alignment` (default `auto`) selects the keyer and
 *  the resolved mode is echoed as `alignedBy`. When `options.baseline` is set,
 *  project a baseline lens over the matrix (a projection, not a second alignment
 *  pass — ADR-047). */
export function alignTrees(
  sources: readonly AlignSource[],
  options?: { readonly baseline?: string; readonly alignment?: AlignmentRequest }
): {
  readonly matrix: ComparisonMatrix;
  readonly baseline?: BaselineLens;
  readonly alignedBy: AlignmentMode;
} {
  const alignedBy = resolveAlignment(sources, options?.alignment ?? 'auto');
  const keyOf = keyerFor(sources, alignedBy);
  const columns: readonly ComparisonColumn[] = sources.map((s) => s.column);
  const maps = sources.map((s) => buildSourceMap(s.rows, keyOf));
  const orderedKeys = sweepOrderedKeys(sources, keyOf);
  const rows: readonly ComparisonMatrixRow[] = orderedKeys.map((key) => ({
    originId: key,
    cells: maps.map((m) => cellFor(m, key)),
  }));
  const matrix: ComparisonMatrix = { columns, rows };
  const baseline = options?.baseline;
  if (baseline === undefined) return { matrix, alignedBy };
  return { matrix, baseline: projectBaseline(matrix, baseline), alignedBy };
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
