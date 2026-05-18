import type { SpecNode, SpecTree, SecRef } from '../../ast/types.js';
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
 * Walks the canonical SpecTree, applies each extraction rule against every
 * node.text, and returns SecRef rows ready for insertRefs().
 *
 * Format-agnostic: any parser that produces a SpecTree (DOCX, .txt, future
 * PDF) can call this to fill ParseResult.refs.
 */
export function extractRefsFromTree(
  tree: SpecTree,
  rules: readonly ExtractionRule[] = DEFAULT_RULES
): readonly SecRef[] {
  const refs: SecRef[] = [];
  const compiledRules: readonly { readonly rule: ExtractionRule; readonly pattern: RegExp }[] =
    rules.map((rule) => ({ rule, pattern: toGlobalPattern(rule) }));
  const walk = (node: SpecNode): void => {
    for (const { rule, pattern } of compiledRules) {
      for (const match of node.text.matchAll(pattern)) {
        refs.push(buildRef(node.id, rule, match));
      }
    }
    node.children.forEach(walk);
  };
  tree.parts.forEach(walk);
  return refs;
}

// matchAll throws TypeError on non-global RegExp. DEFAULT_RULES already use the
// `g` flag, but caller-provided rules may not — coerce defensively.
function toGlobalPattern(rule: ExtractionRule): RegExp {
  if (rule.pattern.global) return rule.pattern;
  return new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
}

function buildRef(sourceNodeId: string, rule: ExtractionRule, match: RegExpMatchArray): SecRef {
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
