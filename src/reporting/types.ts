import { z } from 'zod';

// ── Alignment mode ───────────────────────────────────────────────────────────

/** The alignment strategy actually applied. `origin` keys on resolved paragraph
 *  origin (ADR-047); `structure` keys on the canonical structural address
 *  (ADR-053). */
export type AlignmentMode = 'origin' | 'structure';

/** What the caller may request; `auto` resolves to `origin` when the sources share
 *  a cross-source origin key, to `structure` when they share none but are the same
 *  section, else `origin` (unrelated sections are never falsely paired). */
export type AlignmentRequest = AlignmentMode | 'auto';

// ── Compare source (bare uuid = live spec; object = frozen tree, #392) ───────

/** One comparison source. A bare live-spec UUID is the original, back-compat
 *  shape. An object names the frozen tree of one spec within one issued
 *  package revision (#392, ADR-078) — a `package_revision_specs.tree`
 *  snapshot, not a live `specs` row. */
export type CompareSource = string | { readonly revisionId: string; readonly specId: string };

export const CompareSourceSchema: z.ZodType<CompareSource> = z.union([
  z.uuid(),
  z.object({ revisionId: z.uuid(), specId: z.uuid() }).strict(),
]);

export function isFrozenSource(
  source: CompareSource
): source is { readonly revisionId: string; readonly specId: string } {
  return typeof source !== 'string';
}

/** The live spec id a source's content traces back to: a bare source IS that
 *  id; a frozen source carries it explicitly. Lets `baseline` resolve against
 *  a source's underlying spec instead of requiring literal array membership —
 *  a frozen source's wire shape is always an object, never a bare uuid. */
export function sourceSpecId(source: CompareSource): string {
  return isFrozenSource(source) ? source.specId : source;
}

/** Canonical identity for distinctness. Reference-equality `Set` fails to
 *  dedupe two structurally-identical frozen objects (`{revisionId, specId}`
 *  literals are never `===`); `live:<uuid>` vs. `frozen:<revisionId>:<specId>`
 *  also legally distinguishes a live source from a frozen source of the SAME
 *  underlying spec — that pair is a genuine, intentional comparison. */
function sourceKey(source: CompareSource): string {
  return isFrozenSource(source) ? `frozen:${source.revisionId}:${source.specId}` : `live:${source}`;
}

function checkDistinctSources(sources: readonly CompareSource[]): boolean {
  return new Set(sources.map(sourceKey)).size === sources.length;
}

/** `baseline` must resolve to exactly one source's underlying spec — zero
 *  matches is a typo/unrelated id, ≥2 matches is ambiguous (e.g. the same spec
 *  frozen into two different revisions); both are rejected rather than
 *  silently resolved to "the first match". */
function checkBaselineMatchesExactlyOne(
  sources: readonly CompareSource[],
  baseline: string | undefined
): boolean {
  if (baseline === undefined) return true;
  return sources.filter((s) => sourceSpecId(s) === baseline).length === 1;
}

// ── Request (external input — validated at the boundary) ─────────────────────

/** Exactly two sources: the two supported comparisons (project↔project,
 *  project↔master), now extended to frozen revision trees (#392). The pure
 *  aligner is N-general (see ADR-047); the endpoint gates to 2. `baseline`,
 *  when given, must match exactly one source's underlying spec. */
export const CompareRequestSchema = z
  .object({
    sources: z.array(CompareSourceSchema).length(2),
    baseline: z.uuid().optional(),
    alignment: z.enum(['origin', 'structure', 'auto']).default('auto'),
    include: z.enum(['all', 'differences']).default('all'),
  })
  .superRefine((v, ctx) => {
    if (!checkDistinctSources(v.sources)) {
      ctx.addIssue({
        code: 'custom',
        message: 'sources must be distinct (a spec cannot be compared with itself)',
        path: ['sources'],
      });
    }
    if (!checkBaselineMatchesExactlyOne(v.sources, v.baseline)) {
      ctx.addIssue({
        code: 'custom',
        message: 'baseline must match exactly one of sources',
        path: ['baseline'],
      });
    }
  });
export type CompareRequest = z.infer<typeof CompareRequestSchema>;

// ── Loader → aligner input (internal, not from the wire) ─────────────────────

export interface ComparisonColumn {
  readonly specId: string;
  readonly section: string;
  readonly title: string | null;
  /** Present iff this column was resolved from a frozen source (#392); a live
   *  column never carries these (omitted, not null). */
  readonly revisionId?: string;
  /** The revision's raw `package_revisions.label` — not a nomenclature-
   *  resolved display name (keeps this loader independent of that machinery). */
  readonly revisionLabel?: string;
}

/** One flattened paragraph fed to the pure aligner. Structurally matches the DB
 *  loader's row shape (`ComparisonParagraphRow`); the module boundary keeps the
 *  aligner independent of DB types. */
export interface ComparisonParagraph {
  readonly specId: string;
  readonly id: string; // real paragraph UUID
  readonly originParagraphId: string | null; // migration-018 self-FK; NULL = added-after-clone / origin-deleted
  readonly text: string;
  readonly position: number;
  readonly parentId: string | null;
  readonly nodeType: string;
}

export interface AlignSource {
  readonly column: ComparisonColumn;
  readonly rows: readonly ComparisonParagraph[];
}

// ── The comparison matrix (grounded cells) ───────────────────────────────────

export type ComparisonCell =
  | {
      readonly present: true;
      readonly specId: string;
      readonly paragraphUuid: string;
      readonly text: string;
    }
  | { readonly present: false };

export interface ComparisonMatrixRow {
  readonly originId: string; // resolved-origin alignment key (a REAL paragraph UUID)
  readonly cells: readonly ComparisonCell[]; // index-aligned to columns
}

export interface ComparisonMatrix {
  readonly columns: readonly ComparisonColumn[];
  readonly rows: readonly ComparisonMatrixRow[];
}

// ── Baseline lens (a pure projection over the finished matrix) ───────────────

export type CellState = 'baseline' | 'unchanged' | 'added' | 'removed' | 'modified' | 'absent';

export interface BaselineLensRow {
  readonly originId: string;
  readonly states: readonly CellState[]; // index-aligned to columns
}

export interface BaselineLens {
  readonly specId: string;
  readonly rows: readonly BaselineLensRow[];
}

// ── Summary rollup (grounded counts over the full matrix) ────────────────────

export interface ComparisonSummaryColumn {
  readonly specId: string;
  readonly present: number; // rows where this column's cell is present
  readonly onlyIn: number; // rows present ONLY in this column
}

/** Grounded rollup computed over the FULL matrix (before any `include` filter), so
 *  an agent can cite totals without paging every row. A row is `identical` iff
 *  present in every column with equal text; `differing` = rows − identical (covers
 *  both modified and present-in-only-some rows); `aligned` = present in ≥2 columns. */
export interface ComparisonSummary {
  readonly rows: number;
  readonly aligned: number;
  readonly identical: number;
  readonly differing: number;
  readonly columns: readonly ComparisonSummaryColumn[]; // index-aligned to columns
}

// ── Top-level response payload (`data`) ──────────────────────────────────────

export interface DriftEntry {
  readonly specId: string;
  readonly behindBy: number;
}

export interface ComparisonReport {
  readonly columns: readonly ComparisonColumn[];
  readonly rows: readonly ComparisonMatrixRow[];
  readonly summary: ComparisonSummary; // always emitted (full-matrix rollup)
  readonly alignedBy: AlignmentMode; // the mode actually used
  readonly baseline?: BaselineLens; // present iff request.baseline given
  readonly drift?: readonly DriftEntry[]; // version drift from the lineage chain
}
