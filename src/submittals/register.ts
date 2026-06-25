import type { ParagraphAssociation, SpecTree } from '../ast/index.js';
import { buildSubmittalFindings } from './findings.js';
import { extractProductCandidates } from './products.js';
import { resolveRequiredSubmittalTypes } from './submittal-types.js';
import { normalizedKey } from './text.js';
import type {
  ProductCandidate,
  SpecSubmittalAnalysis,
  SubmittalFinding,
  SubmittalRegister,
  SubmittalRegisterRow,
  SubmittalRegisterSummary,
  SubmittalProductSource,
} from './types.js';

interface RowBucket {
  readonly productName: string;
  readonly requiredSubmittalTypes: readonly string[];
  readonly datasheets: readonly ParagraphAssociation[];
  readonly sources: readonly SubmittalProductSource[];
}

function analyzeSpec(tree: SpecTree): SpecSubmittalAnalysis {
  return {
    specId: tree.id,
    section: tree.section,
    title: tree.title,
    products: extractProductCandidates(tree),
    requiredSubmittalTypes: resolveRequiredSubmittalTypes(tree),
  };
}

function mergeUnique(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])];
}

function mergeDatasheets(
  left: readonly ParagraphAssociation[],
  right: readonly ParagraphAssociation[]
): readonly ParagraphAssociation[] {
  const seen = new Set(left.map((sheet) => sheet.id));
  return [...left, ...right.filter((sheet) => !seen.has(sheet.id))];
}

function addProduct(bucket: RowBucket | undefined, product: ProductCandidate): RowBucket {
  if (bucket === undefined) {
    return {
      productName: product.productName,
      requiredSubmittalTypes: [],
      datasheets: product.datasheets,
      sources: [product.source],
    };
  }
  return {
    productName: bucket.productName,
    requiredSubmittalTypes: bucket.requiredSubmittalTypes,
    datasheets: mergeDatasheets(bucket.datasheets, product.datasheets),
    sources: [...bucket.sources, product.source],
  };
}

function withTypes(bucket: RowBucket, types: readonly string[]): RowBucket {
  return { ...bucket, requiredSubmittalTypes: mergeUnique(bucket.requiredSubmittalTypes, types) };
}

function buildRows(specs: readonly SpecSubmittalAnalysis[]): readonly SubmittalRegisterRow[] {
  const buckets = new Map<string, RowBucket>();
  for (const spec of specs) {
    for (const product of spec.products) {
      const key = normalizedKey(product.productName);
      const bucket = withTypes(addProduct(buckets.get(key), product), spec.requiredSubmittalTypes);
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    datasheetStatus: bucket.datasheets.length > 0 ? 'present' : 'missing',
  }));
}

function count(findings: readonly SubmittalFinding[], type: SubmittalFinding['type']): number {
  return findings.filter((finding) => finding.type === type).length;
}

function summarize(
  rows: readonly SubmittalRegisterRow[],
  findings: readonly SubmittalFinding[]
): SubmittalRegisterSummary {
  return {
    rows: rows.length,
    productWithoutSubmittalType: count(findings, 'product_without_submittal_type'),
    submittalTypeWithoutProduct: count(findings, 'submittal_type_without_product'),
    productMissingDatasheet: count(findings, 'product_missing_datasheet'),
    totalFindings: findings.length,
  };
}

export function buildSubmittalRegister(trees: readonly SpecTree[]): SubmittalRegister {
  const analyses = trees.map(analyzeSpec);
  const rows = buildRows(analyses);
  const findings = buildSubmittalFindings(analyses);
  return { rows, findings, summary: summarize(rows, findings), notes: [] };
}
