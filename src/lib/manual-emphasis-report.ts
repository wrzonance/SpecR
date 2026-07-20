import type { NodeType, SourceEmphasisFact, SpecNode, SpecTree } from '../ast/index.js';

export interface ManualEmphasisFinding {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly text: string;
  /** Section and ancestor headings ending at the flagged paragraph. */
  readonly outlinePath: readonly string[];
  readonly emphasis: readonly SourceEmphasisFact[];
}

export interface ManualEmphasisReport {
  readonly total: number;
  readonly findings: readonly ManualEmphasisFinding[];
}

function findingsFor(
  nodes: readonly SpecNode[],
  ancestorPath: readonly string[]
): readonly ManualEmphasisFinding[] {
  return nodes.flatMap((node) => {
    const outlinePath = [...ancestorPath, node.text];
    const emphasis = node.meta.sourceFacts?.emphasis ?? [];
    const own =
      emphasis.length > 0
        ? [{ nodeId: node.id, nodeType: node.type, text: node.text, outlinePath, emphasis }]
        : [];
    return [...own, ...findingsFor(node.children, outlinePath)];
  });
}

export function summarizeManualEmphasis(tree: SpecTree): ManualEmphasisReport {
  const findings = findingsFor(tree.parts, [tree.section]);
  return { total: findings.length, findings };
}
