import {
  resolveSourceHighlights,
  type NodeType,
  type SourceHighlightFact,
  type SpecNode,
  type SpecTree,
} from '../ast/index.js';

export interface HighlightReviewFinding {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly text: string;
  /** Section and ancestor headings ending at the flagged paragraph. */
  readonly outlinePath: readonly string[];
  readonly highlights: readonly SourceHighlightFact[];
}

export interface HighlightReviewReport {
  /** Number of paragraphs carrying one or more highlight clues. */
  readonly total: number;
  readonly findings: readonly HighlightReviewFinding[];
}

function findingsFor(
  nodes: readonly SpecNode[],
  ancestorPath: readonly string[]
): readonly HighlightReviewFinding[] {
  return nodes.flatMap((node) => {
    const outlinePath = [...ancestorPath, node.text];
    const highlights = resolveSourceHighlights(node.text, node.meta.sourceFacts ?? {}).map(
      (resolved) => resolved.fact
    );
    const own =
      highlights.length > 0
        ? [{ nodeId: node.id, nodeType: node.type, text: node.text, outlinePath, highlights }]
        : [];
    return [...own, ...findingsFor(node.children, outlinePath)];
  });
}

export function summarizeHighlightReview(tree: SpecTree): HighlightReviewReport {
  const findings = findingsFor(tree.parts, [tree.section]);
  return { total: findings.length, findings };
}
