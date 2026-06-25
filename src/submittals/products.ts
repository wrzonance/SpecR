import type { ParagraphAssociation, SpecNode, SpecTree } from '../ast/index.js';
import type { ProductCandidate } from './types.js';
import { normalizedKey, normalizeText, stripCsiPrefix, titleCase } from './text.js';

const PRODUCT_NODE_TYPES = new Set<SpecNode['type']>(['pr1', 'pr2']);
const GENERIC_ARTICLES = new Set([
  'accessories',
  'fabrication',
  'general',
  'manufacturers',
  'materials',
  'performance requirements',
  'products',
  'quality control',
  'source quality control',
]);
const REJECT_PARAGRAPH_START = /^(provide|submit|install|coordinate|comply|conform|see|verify)\b/i;

function isProductsPart(node: SpecNode): boolean {
  if (node.type !== 'part') return false;
  const key = normalizedKey(node.text);
  return key.includes('products') || key.startsWith('part 2');
}

function source(tree: SpecTree, node: SpecNode) {
  return {
    specId: tree.id,
    section: tree.section,
    title: tree.title,
    paragraphId: node.id,
    paragraphText: node.text,
  };
}

function associationsIn(node: SpecNode): readonly ParagraphAssociation[] {
  return [node.meta.associations ?? [], ...node.children.map(associationsIn)].flat();
}

function productFromParagraph(text: string): string | null {
  const clean = stripCsiPrefix(text);
  const colon = clean.indexOf(':');
  const candidate = colon > 0 ? clean.slice(0, colon) : clean;
  const normalized = normalizeText(candidate);
  if (normalized.length === 0 || normalized.length > 90) return null;
  if (REJECT_PARAGRAPH_START.test(normalized)) return null;
  if (!colon && normalized.split(' ').length > 6) return null;
  if (normalizedKey(normalized).includes('product data')) return null;
  return titleCase(normalized);
}

function articleCandidate(tree: SpecTree, article: SpecNode): ProductCandidate | null {
  const name = titleCase(article.text);
  if (name.length === 0 || GENERIC_ARTICLES.has(normalizedKey(name))) return null;
  return { productName: name, source: source(tree, article), datasheets: associationsIn(article) };
}

function paragraphCandidates(tree: SpecTree, article: SpecNode): readonly ProductCandidate[] {
  return article.children.flatMap((child) => {
    if (!PRODUCT_NODE_TYPES.has(child.type)) return [];
    const productName = productFromParagraph(child.text);
    if (productName === null) return [];
    return [{ productName, source: source(tree, child), datasheets: associationsIn(child) }];
  });
}

function candidatesFromArticle(tree: SpecTree, article: SpecNode): readonly ProductCandidate[] {
  const articleProduct = articleCandidate(tree, article);
  if (articleProduct !== null) return [articleProduct];
  return paragraphCandidates(tree, article);
}

export function extractProductCandidates(tree: SpecTree): readonly ProductCandidate[] {
  const productsPart = tree.parts.find(isProductsPart);
  if (productsPart === undefined) return [];
  return productsPart.children.flatMap((child) => {
    if (child.type === 'article') return candidatesFromArticle(tree, child);
    if (!PRODUCT_NODE_TYPES.has(child.type)) return [];
    const productName = productFromParagraph(child.text);
    return productName === null
      ? []
      : [{ productName, source: source(tree, child), datasheets: associationsIn(child) }];
  });
}
