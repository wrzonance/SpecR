import type { CsiNode, CsiTree, SecRef } from '../../ast/types.js';
import {
  SECTION_REF_RULES,
  STANDARD_ORG_PATTERNS,
  buildStandardRefRules,
  type ExtractionRule,
} from './rules.js';

const DEFAULT_RULES: readonly ExtractionRule[] = [
  ...SECTION_REF_RULES,
  ...buildStandardRefRules(STANDARD_ORG_PATTERNS),
];

/**
 * Walks the canonical CsiTree, applies each extraction rule against every
 * node.text, and returns SecRef rows ready for insertRefs().
 *
 * Format-agnostic: any parser that produces a CsiTree (DOCX, .txt, future
 * PDF) can call this to fill ParseResult.refs.
 */
export function extractRefsFromTree(
  tree: CsiTree,
  rules: readonly ExtractionRule[] = DEFAULT_RULES
): readonly SecRef[] {
  const refs: SecRef[] = [];
  const walk = (node: CsiNode): void => {
    for (const rule of rules) {
      // Fresh iterator per (rule, node) — global regex state is per-iterator
      // in matchAll, so this is safe and deterministic.
      for (const match of node.text.matchAll(rule.pattern)) {
        refs.push(buildRef(node.id, rule, match));
      }
    }
    node.children.forEach(walk);
  };
  tree.parts.forEach(walk);
  return refs;
}

function buildRef(
  sourceNodeId: string,
  rule: ExtractionRule,
  match: RegExpMatchArray
): SecRef {
  if (rule.targetType === 'section') {
    return {
      sourceNodeId,
      targetType: 'section',
      targetSpecSection: `${match[1]} ${match[2]} ${match[3]}`,
      referenceText: match[0],
    };
  }
  return {
    sourceNodeId,
    targetType: 'standard',
    standardCode: `${match[1]} ${match[2]}`,
    referenceText: match[0],
  };
}
