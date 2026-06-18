import type { Editability, ClassificationEvidence } from '../ast/index.js';

// ClassificationEvidence (the why-chain entry: which rule fired, which fact it
// matched) lives in ast/ (the foundational layer) next to its closed Zod schema,
// so the #134 storage boundary and SpecNodeMeta both validate the same shape.
// Re-exported here for the engine's public surface (ADR-022 D4).
export type { ClassificationEvidence } from '../ast/index.js';

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
  /** Ordered why-chain: the deciding rung first; never empty (≥1 entry). */
  readonly evidence: readonly [ClassificationEvidence, ...ClassificationEvidence[]];
}

/** One classification per paragraph node, in document order (pre-order tree walk). */
export type ClassifyResult = readonly ParagraphClassification[];
