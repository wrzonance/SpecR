import {
  getComparisonColumns,
  getComparisonParagraphs,
  getFrozenComparisonSource,
  getSpecLineage,
  type ComparisonColumnMeta,
  type ComparisonParagraphRow,
} from '../db/index.js';
import { alignTrees } from './align.js';
import { flattenSpecTree } from './frozen-tree.js';
import { summarize, filterToDifferences } from './summary.js';
import { SpecNotFoundError } from './error.js';
import { isFrozenSource } from './types.js';
import type {
  AlignmentRequest,
  AlignSource,
  CompareSource,
  ComparisonColumn,
  ComparisonReport,
  DriftEntry,
} from './types.js';

function toColumn(meta: ComparisonColumnMeta): ComparisonColumn {
  return { specId: meta.specId, section: meta.section, title: meta.title };
}

function indexMeta(
  metas: readonly ComparisonColumnMeta[]
): ReadonlyMap<string, ComparisonColumnMeta> {
  return new Map(metas.map((m) => [m.specId, m]));
}

/** The distinct LIVE (bare-uuid) sources, in first-occurrence request order.
 *  Shared by the batch loader and the drift walker: drift ordering only lines
 *  up with the loaded population while both derive it the same way, so this is
 *  one function rather than two expressions that must stay identical. */
function liveSpecIdsOf(sources: readonly CompareSource[]): readonly string[] {
  return [...new Set(sources.filter((s): s is string => typeof s === 'string'))];
}

/** Batch-load column metadata + paragraphs for every LIVE (bare-uuid) source in
 *  one round trip each, keyed for `resolveSource` to look up positionally.
 *  Frozen sources are resolved individually in `resolveSource` — a revision
 *  snapshot is a single-row JOIN, not worth batching. */
async function resolveLiveSources(sources: readonly CompareSource[]): Promise<{
  readonly metaMap: ReadonlyMap<string, ComparisonColumnMeta>;
  readonly rows: readonly ComparisonParagraphRow[];
}> {
  const liveSpecIds = liveSpecIdsOf(sources);
  if (liveSpecIds.length === 0) return { metaMap: new Map(), rows: [] };

  const metas = await getComparisonColumns(liveSpecIds);
  const metaMap = indexMeta(metas);
  const missing = liveSpecIds.filter((id) => !metaMap.has(id));
  if (missing.length > 0) {
    throw new SpecNotFoundError(`spec(s) not found: ${missing.join(', ')}`);
  }

  const rows = await getComparisonParagraphs(liveSpecIds);
  return { metaMap, rows };
}

/** Resolve one frozen source into an aligner-ready column + flattened rows. A
 *  null lookup covers both "revision doesn't exist" and "revision exists but
 *  specId was never one of its frozen members" — the caller doesn't need the
 *  two causes told apart, so one error names both ids (#392, ADR-078). */
async function resolveFrozenSource(source: {
  readonly revisionId: string;
  readonly specId: string;
}): Promise<AlignSource> {
  const frozen = await getFrozenComparisonSource(source.revisionId, source.specId);
  if (frozen === null) {
    throw new SpecNotFoundError(
      `frozen source not found: revisionId=${source.revisionId}, specId=${source.specId}`
    );
  }
  const column: ComparisonColumn = {
    specId: source.specId,
    section: frozen.tree.section,
    title: frozen.tree.title,
    revisionId: source.revisionId,
    revisionLabel: frozen.revisionLabel,
  };
  return { column, rows: flattenSpecTree(frozen.tree, source.specId) };
}

/** Dispatch one source (in request position) to its column + rows. Live
 *  sources read from the pre-loaded `resolveLiveSources` maps; frozen sources
 *  fetch their own snapshot. specId is no longer a safe whole-request identity
 *  key (the same spec may appear live once and frozen once, or frozen twice at
 *  different revisions), so resolution is positional, not set-based (#392). */
async function resolveSource(
  source: CompareSource,
  liveMetaMap: ReadonlyMap<string, ComparisonColumnMeta>,
  liveRows: readonly ComparisonParagraphRow[]
): Promise<AlignSource> {
  if (isFrozenSource(source)) return resolveFrozenSource(source);
  const meta = liveMetaMap.get(source);
  if (meta === undefined) throw new SpecNotFoundError(`spec not found: ${source}`);
  return { column: toColumn(meta), rows: liveRows.filter((r) => r.specId === source) };
}

/** Version drift for a cloned source: the immediate parent hop's behindBy from
 *  the lineage chain (chain[0] carries this copy's drift vs its parent). NULL
 *  parent or unresolved drift → no entry. */
async function driftFor(meta: ComparisonColumnMeta): Promise<DriftEntry | null> {
  if (meta.parentSpecId === null) return null;
  const lineage = await getSpecLineage(meta.specId);
  const hop = lineage?.chain[0];
  if (hop === undefined || hop.behindBy === null) return null;
  return { specId: meta.specId, behindBy: hop.behindBy };
}

/** Drift is scoped to the live bucket only (#392 D9) — a frozen source is a
 *  point-in-time tree snapshot with no lineage of its own to walk; it is
 *  omitted from `drift`, never faked. */
async function computeDrift(
  metas: readonly ComparisonColumnMeta[]
): Promise<readonly DriftEntry[]> {
  const entries = await Promise.all(metas.map(driftFor));
  return entries.filter((e): e is DriftEntry => e !== null);
}

/** The live specs actually requested, in first-occurrence request order, with
 *  their metadata — the population `computeDrift` walks. */
function liveOrderedMetas(
  sources: readonly CompareSource[],
  metaMap: ReadonlyMap<string, ComparisonColumnMeta>
): readonly ComparisonColumnMeta[] {
  return liveSpecIdsOf(sources)
    .map((specId) => metaMap.get(specId))
    .filter((m): m is ComparisonColumnMeta => m !== undefined);
}

/** Fetch → guard → align → summarize → (filter) → drift. Impure orchestrator; all
 *  facts are computed (set-join over stored paragraphs), never synthesized. The
 *  summary is grounded on the FULL matrix even when `include: 'differences'` trims
 *  the returned rows (ADR-047/053). */
export async function buildComparisonReport(
  sources: readonly CompareSource[],
  options: {
    readonly baseline?: string;
    readonly alignment?: AlignmentRequest;
    readonly include?: 'all' | 'differences';
  } = {}
): Promise<ComparisonReport> {
  const { metaMap, rows } = await resolveLiveSources(sources);
  const alignSources = await Promise.all(sources.map((s) => resolveSource(s, metaMap, rows)));

  const alignOpts = {
    ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
    ...(options.alignment !== undefined ? { alignment: options.alignment } : {}),
  };
  const { matrix, baseline, alignedBy } = alignTrees(alignSources, alignOpts);
  const summary = summarize(matrix); // full matrix — never the filtered view
  const view =
    options.include === 'differences'
      ? filterToDifferences(matrix, baseline)
      : { matrix, baseline };

  // Drift follows request/column order (via metaMap), not DB row order, so the
  // serialized `drift` array is byte-identical every run — the deterministic
  // report guarantee (ADR-047) covers the whole body, not just the matrix.
  const drift = await computeDrift(liveOrderedMetas(sources, metaMap));

  return {
    columns: view.matrix.columns,
    rows: view.matrix.rows,
    summary,
    alignedBy,
    ...(view.baseline ? { baseline: view.baseline } : {}),
    ...(drift.length > 0 ? { drift } : {}),
  };
}
