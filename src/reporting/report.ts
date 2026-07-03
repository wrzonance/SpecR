import {
  getComparisonColumns,
  getComparisonParagraphs,
  getSpecLineage,
  type ComparisonColumnMeta,
  type ComparisonParagraphRow,
} from '../db/index.js';
import { alignTrees } from './align.js';
import { SpecNotFoundError } from './error.js';
import type { AlignSource, ComparisonColumn, ComparisonReport, DriftEntry } from './types.js';

function toColumn(meta: ComparisonColumnMeta): ComparisonColumn {
  return { specId: meta.specId, section: meta.section, title: meta.title };
}

function indexMeta(
  metas: readonly ComparisonColumnMeta[]
): ReadonlyMap<string, ComparisonColumnMeta> {
  return new Map(metas.map((m) => [m.specId, m]));
}

function assertAllFound(
  sources: readonly string[],
  metaMap: ReadonlyMap<string, ComparisonColumnMeta>
): void {
  const missing = [...new Set(sources.filter((s) => !metaMap.has(s)))];
  if (missing.length > 0) {
    throw new SpecNotFoundError(`spec(s) not found: ${missing.join(', ')}`);
  }
}

/** Group loaded rows into aligner sources in REQUEST order (columns follow the
 *  request, not the DB). Rows arrive pre-sorted, so per-source order is stable. */
function buildSources(
  sources: readonly string[],
  metaMap: ReadonlyMap<string, ComparisonColumnMeta>,
  rows: readonly ComparisonParagraphRow[]
): readonly AlignSource[] {
  return sources.map((specId) => {
    const meta = metaMap.get(specId);
    if (meta === undefined) throw new SpecNotFoundError(`spec not found: ${specId}`);
    return { column: toColumn(meta), rows: rows.filter((r) => r.specId === specId) };
  });
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

async function computeDrift(
  metas: readonly ComparisonColumnMeta[]
): Promise<readonly DriftEntry[]> {
  const entries = await Promise.all(metas.map(driftFor));
  return entries.filter((e): e is DriftEntry => e !== null);
}

/** Fetch → guard → align → project → drift. Impure orchestrator; all facts are
 *  computed (set-join over stored paragraphs), never synthesized (ADR-047). */
export async function buildComparisonReport(
  sources: readonly string[],
  options: { readonly baseline?: string } = {}
): Promise<ComparisonReport> {
  const distinct = [...new Set(sources)];
  const metas = await getComparisonColumns(distinct);
  const metaMap = indexMeta(metas);
  assertAllFound(sources, metaMap);

  const rows = await getComparisonParagraphs(distinct);
  const { matrix, baseline } = alignTrees(buildSources(sources, metaMap, rows), options);
  const drift = await computeDrift(metas);

  return {
    columns: matrix.columns,
    rows: matrix.rows,
    ...(baseline ? { baseline } : {}),
    ...(drift.length > 0 ? { drift } : {}),
  };
}
