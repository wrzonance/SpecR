import { z } from 'zod';

// ── Alignment mode ───────────────────────────────────────────────────────────

/** The alignment strategy actually applied. `origin` keys on resolved paragraph
 *  origin (ADR-047); `structure` keys on the canonical structural address
 *  (ADR-053). */
export type AlignmentMode = 'origin' | 'structure';

/** What the caller may request; `auto` resolves to `origin` when the sources
 *  share a cross-source origin key, else `structure`. */
export type AlignmentRequest = AlignmentMode | 'auto';

// ── Request (external input — validated at the boundary) ─────────────────────

/** Exactly two sources: the two supported comparisons (project↔project,
 *  project↔master). The pure aligner is N-general (see ADR-047); the endpoint
 *  gates to 2. `baseline`, when given, must be one of `sources`. */
export const CompareRequestSchema = z
  .object({
    sources: z.array(z.uuid()).length(2),
    baseline: z.uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.sources).size !== v.sources.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'sources must be distinct (a spec cannot be compared with itself)',
        path: ['sources'],
      });
    }
    if (v.baseline !== undefined && !v.sources.includes(v.baseline)) {
      ctx.addIssue({
        code: 'custom',
        message: 'baseline must be one of sources',
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
  readonly baseline?: BaselineLens; // present iff request.baseline given
  readonly drift?: readonly DriftEntry[]; // version drift from the lineage chain
}
