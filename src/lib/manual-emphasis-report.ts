import type { NodeType, SourceEmphasisFact, SpecNode, SpecTree } from '../ast/index.js';

export interface ManualEmphasisFinding {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly text: string;
  readonly emphasis: readonly SourceEmphasisFact[];
}

export interface ManualEmphasisReport {
  readonly total: number;
  readonly findings: readonly ManualEmphasisFinding[];
}

function findingsFor(nodes: readonly SpecNode[]): readonly ManualEmphasisFinding[] {
  return nodes.flatMap((node) => {
    const emphasis = node.meta.sourceFacts?.emphasis ?? [];
    const own =
      emphasis.length > 0
        ? [{ nodeId: node.id, nodeType: node.type, text: node.text, emphasis }]
        : [];
    return [...own, ...findingsFor(node.children)];
  });
}

export function summarizeManualEmphasis(tree: SpecTree): ManualEmphasisReport {
  const findings = findingsFor(tree.parts);
  return { total: findings.length, findings };
}
