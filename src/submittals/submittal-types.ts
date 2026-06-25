import type { SpecNode, SpecTree } from '../ast/index.js';
import { deriveArticleRole } from '../ast/index.js';
import { normalizedKey } from './text.js';

interface TypeRule {
  readonly label: string;
  readonly pattern: RegExp;
}

const TYPE_RULES: readonly TypeRule[] = [
  { label: 'Product Data', pattern: /\b(?:sd-?03\s+)?product data\b/i },
  { label: 'Shop Drawings', pattern: /\b(?:sd-?02\s+)?shop drawings?\b/i },
  { label: 'Samples', pattern: /\b(?:sd-?04\s+)?samples?\b/i },
  { label: 'Design Data', pattern: /\b(?:sd-?05\s+)?design data\b/i },
  { label: 'Test Reports', pattern: /\b(?:sd-?06\s+)?test reports?\b/i },
  {
    label: 'Certificates',
    pattern: /\b(?:sd-?07\s+)?(?:certificates?|manufacturer'?s certificates?)\b/i,
  },
  {
    label: 'Operation and Maintenance Data',
    pattern: /\b(?:sd-?10\s+)?(?:operation and maintenance data|o&m data)\b/i,
  },
];

function isPartOne(node: SpecNode, index: number): boolean {
  if (node.type !== 'part') return false;
  const key = normalizedKey(node.text);
  return key.includes('general') || key.startsWith(`part ${index + 1}`) || key.startsWith('part 1');
}

function isSubmittalsArticle(node: SpecNode): boolean {
  if (node.type !== 'article') return false;
  return node.meta.articleRole === 'submittals' || deriveArticleRole(node.text) === 'submittals';
}

function allText(node: SpecNode): readonly string[] {
  if (node.meta.vanish === true) return [];
  return [node.text, ...node.children.flatMap(allText)];
}

function isNegated(text: string): boolean {
  return /\b(not required|not be required|no product data required)\b/i.test(text);
}

function matchingTypes(text: string): readonly string[] {
  if (isNegated(text)) return [];
  return TYPE_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
}

export function resolveRequiredSubmittalTypes(tree: SpecTree): readonly string[] {
  const partOne = tree.parts.find(isPartOne);
  const submittals = partOne?.children.filter(isSubmittalsArticle) ?? [];
  const seen = new Set<string>();
  for (const article of submittals) {
    for (const text of allText(article)) {
      for (const type of matchingTypes(text)) seen.add(type);
    }
  }
  return TYPE_RULES.map((rule) => rule.label).filter((label) => seen.has(label));
}
