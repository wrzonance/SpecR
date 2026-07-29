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
 *  match. `origin` and `structure` keyers below produce comparable keys.
 *  `sourceIndex` is which `sources[]` slot the row was drawn from — needed
 *  because paragraph ids are no longer globally unique across sources once a
 *  spec can appear more than once (live + frozen, or frozen at two different
 *  revisions, #392); the origin keyer ignores it, the structural keyer does not. */
type Keyer = (p: ComparisonParagraph, sourceIndex: number) => string;

/** True iff every source names the SAME underlying live spec (#392: a spec may
 *  appear live once and frozen at 1-2 different revisions, or twice frozen).
 *  Same-spec columns share literal paragraph UUIDs by construction (ADR-078
 *  §6) for any unedited/undeleted paragraph — this is the stable identity to
 *  key on, independent of whether either snapshot happens to carry embedded
 *  lineage metadata. */
function isSameSpecComparison(sources: readonly AlignSource[]): boolean {
  return sources.length > 1 && new Set(sources.map((s) => s.column.specId)).size === 1;
}

/** Origin keyer (ADR-047), specId-aware (#392 review finding). For a SAME-spec
 *  pair, `originParagraphId` must not be trusted: it is embedded only at
 *  freeze time (revision-snapshot.ts) and is entirely absent from any
 *  snapshot frozen before #392 shipped. Mixing a legacy (absent) snapshot
 *  against a new (embedded) snapshot of the SAME spec would key a locally-
 *  authored paragraph by its own id on both sides (matches, correctly) while
 *  keying a lineage-carrying paragraph by its own id on the legacy side but
 *  by its MASTER's id on the new side (never matches) — silently showing an
 *  unedited cloned paragraph as removed-then-added. Own-id keying sidesteps
 *  this entirely: same-spec snapshots share real paragraph UUIDs natively
 *  (ADR-078 §6), so lineage metadata is never needed for this case. A
 *  cross-spec pair (clone vs. its master, or two clones of the same master)
 *  keeps the original COALESCE: a cloned paragraph aligns on its master
 *  origin; a NULL-origin paragraph (added-after-clone, origin-deleted, or a
 *  root master) keys on its own id and surfaces as only-in-X. */
function originKeyerFor(sources: readonly AlignSource[]): Keyer {
  const sameSpec = isSameSpecComparison(sources);
  return (p) => (sameSpec ? p.id : (p.originParagraphId ?? p.id));
}

/** True iff any key occurs in ≥2 distinct sources under the given keyer — i.e.
 *  the pair descends from a shared master (project↔project), is project↔its-
 *  own-master, or is a same-spec pair (own ids trivially recur). Drives the
 *  `auto` fallback: no cross-source overlap → independently-ingested. */
function sharesCrossSourceOrigin(sources: readonly AlignSource[], keyOf: Keyer): boolean {
  const firstSeenIn = new Map<string, number>();
  for (let i = 0; i < sources.length; i += 1) {
    for (const row of sources[i]?.rows ?? []) {
      const k = keyOf(row, i);
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
  if (sharesCrossSourceOrigin(sources, originKeyerFor(sources))) return 'origin';
  // No shared origin: fall back to structure only for same-section peers. Different
  // sections stay on origin (→ all only-in rows), never falsely paired by address.
  return sourcesShareSection(sources) ? 'structure' : 'origin';
}

/** Structural keyer (ADR-053), ONE address map PER SOURCE (#392 review
 *  finding) — paragraph ids can now repeat ACROSS sources (same spec live +
 *  frozen, or frozen at two different revisions), so a single map merged
 *  across all sources would let a later source's computed address silently
 *  clobber an earlier source's entry for a shared id, corrupting that
 *  source's own alignment (and, via `buildSourceMap`'s first-wins collision
 *  rule, potentially dropping one of its rows outright). Each row looks up
 *  its address ONLY in its own source's map. A row with no computed address
 *  falls back to its own id. */
function structuralKeyer(sources: readonly AlignSource[]): Keyer {
  const perSource = sources.map((source) => computeStructuralKeys(source.rows));
  return (p, sourceIndex) => perSource[sourceIndex]?.get(p.id) ?? p.id;
}

function keyerFor(sources: readonly AlignSource[], mode: AlignmentMode): Keyer {
  return mode === 'origin' ? originKeyerFor(sources) : structuralKeyer(sources);
}

/** First-wins on collision. Rows arrive pre-sorted by (position, id) so the
 *  winner is deterministic.
 *  // KNOWN AMBIGUITY: two paragraphs in one source resolving to the same key
 *  // — first by (position, id) wins; the loser is dropped from that column. */
function buildSourceMap(
  rows: readonly ComparisonParagraph[],
  sourceIndex: number,
  keyOf: Keyer
): ReadonlyMap<string, ComparisonParagraph> {
  const map = new Map<string, ComparisonParagraph>();
  for (const row of rows) {
    const k = keyOf(row, sourceIndex);
    if (!map.has(k)) map.set(k, row);
  }
  return map;
}

/** The deterministic row order: first-occurrence sweep, left-to-right across
 *  sources and top-to-bottom within each source's (position, id) order. */
function sweepOrderedKeys(sources: readonly AlignSource[], keyOf: Keyer): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    for (const row of sources[i]?.rows ?? []) {
      const k = keyOf(row, i);
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
  const maps = sources.map((s, i) => buildSourceMap(s.rows, i, keyOf));
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
