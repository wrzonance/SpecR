// src/lib/hierarchy-summary.ts
import type { NodeType, SpecNode, SpecTree } from '../ast/index.js';
import { nodeTypeToNormalizedIlvl } from '../ast/index.js';

/** Below this hierarchy-inference confidence a paragraph is surfaced for human
 *  review (ADR-055; mirrors editability's LOW_CONFIDENCE_THRESHOLD pattern). */
export const HIERARCHY_REVIEW_THRESHOLD = 0.6;

export interface HierarchyLowConfidenceEntry {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly ilvl: number;
  readonly confidence: number;
  readonly evidence: readonly string[];
}

export interface HierarchySummary {
  readonly counts: {
    readonly scored: number;
    readonly unscored: number;
    readonly belowThreshold: number;
  };
  /** Present when unscored > 0 — why, never folded into another bucket (ADR-055). */
  readonly unscoredReason?: string;
  /** Scored paragraphs below the review threshold, worst-first. */
  readonly lowConfidence: readonly HierarchyLowConfidenceEntry[];
}

// Non-structural node types are never scored (same skip-set the renderers use);
// vanish nodes are skipped via the meta flag.
const NON_STRUCTURAL = new Set<NodeType>(['spec', 'note', 'continuation']);

const EXPLICIT_STRUCTURE_REASON = 'explicit structure from source markup — no inference to score';
const PRE_PROVENANCE_REASON =
  'no inference provenance recorded (pre-provenance parse or manually inserted paragraph) — re-import the master to score';

interface Acc {
  scored: number;
  unscored: number;
  belowThreshold: number;
  readonly lowConfidence: HierarchyLowConfidenceEntry[];
}

function tally(n: SpecNode, acc: Acc, threshold: number): void {
  const inference = n.meta.inference;
  if (!inference) {
    acc.unscored += 1;
    return;
  }
  acc.scored += 1;
  if (inference.confidence < threshold) {
    acc.belowThreshold += 1;
    acc.lowConfidence.push({
      nodeId: n.id,
      nodeType: n.type,
      ilvl: nodeTypeToNormalizedIlvl(n.type),
      confidence: inference.confidence,
      evidence: inference.evidence,
    });
  }
}

function walk(nodes: readonly SpecNode[], acc: Acc, threshold: number): void {
  for (const n of nodes) {
    if (!NON_STRUCTURAL.has(n.type) && n.meta.vanish !== true) {
      tally(n, acc, threshold);
    }
    walk(n.children, acc, threshold);
  }
}

/**
 * Summarize hierarchy-inference confidence over a spec tree (ADR-055): counts of
 * scored/unscored/below-threshold structural paragraphs plus the worst-first
 * triage list. `source` is the spec's persisted source label — an explicit-
 * structure source ('ufgs' = SpecsIntact SEC markup) is unscored by design, not
 * suspect. Shared by the REST onboarding report and the MCP
 * `get_onboarding_report` tool so the two cannot drift.
 */
export function summarizeHierarchy(
  tree: SpecTree,
  source: string | null,
  threshold: number = HIERARCHY_REVIEW_THRESHOLD
): HierarchySummary {
  const acc: Acc = { scored: 0, unscored: 0, belowThreshold: 0, lowConfidence: [] };
  walk(tree.parts, acc, threshold);
  const lowConfidence = [...acc.lowConfidence].sort(
    (a, b) => a.confidence - b.confidence || a.nodeId.localeCompare(b.nodeId)
  );
  return {
    counts: { scored: acc.scored, unscored: acc.unscored, belowThreshold: acc.belowThreshold },
    ...(acc.unscored > 0
      ? { unscoredReason: source === 'ufgs' ? EXPLICIT_STRUCTURE_REASON : PRE_PROVENANCE_REASON }
      : {}),
    lowConfidence,
  };
}
