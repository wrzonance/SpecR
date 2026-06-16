import type { Editability } from '../ast/index.js';

/**
 * Why a paragraph received its classification: which convention rule fired and
 * which stored source fact it matched. Both are stable dotted/bracketed paths
 * (`colorMeanings[0000FF]`, `colors[0]`) so a reviewer or UI can trace a verdict
 * back to its inputs without re-running the engine (ADR-022 D4 — evidence
 * references the specific rule and fact).
 */
export interface ClassificationEvidence {
  /** The convention rule that decided, e.g. `colorMeanings[0000FF]`, `defaultEditability`. */
  readonly rule: string;
  /** The source fact path that matched, e.g. `colors[0]`, `banner`; absent when no fact fired. */
  readonly fact?: string;
  /** Human-readable note (e.g. why a rung fell through). Optional. */
  readonly detail?: string;
}

/**
 * The machine's first-pass verdict for one paragraph (ADR-022 D2 — the
 * `classification` half; user `override` is a separate field stored elsewhere).
 */
export interface ParagraphClassification {
  /** AST node id (SpecNode.id) this verdict belongs to. */
  readonly nodeId: string;
  /** Closed four-value vocabulary (ADR-022 D1). */
  readonly editability: Editability;
  /** 0..1 — signal strength (e.g. full-paragraph color = high, sparse = low). */
  readonly confidence: number;
  /** Ordered why-chain: the deciding rung first; never empty. */
  readonly evidence: readonly ClassificationEvidence[];
}

/** One classification per paragraph node, in document order (pre-order tree walk). */
export type ClassifyResult = readonly ParagraphClassification[];
