import type { SpecTree, SpecNode, Editability } from '../ast/index.js';
import type { EditabilitySummary } from '../lib/jobs.js';

/** Below this machine confidence, a classification is surfaced for human review. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

interface Acc {
  readonly counts: Record<Editability, number>;
  readonly lowConfidence: { nodeId: string; value: Editability; confidence: number }[];
}

function walk(nodes: readonly SpecNode[], acc: Acc, threshold: number): void {
  for (const n of nodes) {
    const e = n.meta.editability;
    if (e) {
      acc.counts[e.value] += 1;
      if (e.confidence < threshold) {
        acc.lowConfidence.push({ nodeId: n.id, value: e.value, confidence: e.confidence });
      }
    }
    walk(n.children, acc, threshold);
  }
}

/**
 * Summarize a classified spec tree (O-8 report §editability): counts of the
 * effective editability value per closed vocabulary entry, plus the nodes whose
 * machine confidence falls below the review threshold. Pure over the tree —
 * unclassified (structural) nodes are skipped.
 */
export function summarizeEditability(
  tree: SpecTree,
  threshold: number = LOW_CONFIDENCE_THRESHOLD
): EditabilitySummary {
  const acc: Acc = {
    counts: { locked: 0, editable: 0, choice: 0, note: 0 },
    lowConfidence: [],
  };
  walk(tree.parts, acc, threshold);
  return { counts: acc.counts, lowConfidence: acc.lowConfidence };
}
