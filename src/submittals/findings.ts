import type { SpecSubmittalAnalysis, SubmittalFinding } from './types.js';

function productWithoutType(spec: SpecSubmittalAnalysis): readonly SubmittalFinding[] {
  if (spec.requiredSubmittalTypes.length > 0) return [];
  return spec.products.map((product) => ({
    type: 'product_without_submittal_type',
    specId: spec.specId,
    sourceSpecSection: spec.section,
    productName: product.productName,
    sourceParagraphId: product.source.paragraphId,
  }));
}

function typeWithoutProduct(spec: SpecSubmittalAnalysis): readonly SubmittalFinding[] {
  if (spec.products.length > 0) return [];
  return spec.requiredSubmittalTypes.map((submittalType) => ({
    type: 'submittal_type_without_product',
    specId: spec.specId,
    sourceSpecSection: spec.section,
    submittalType,
  }));
}

function productMissingDatasheet(spec: SpecSubmittalAnalysis): readonly SubmittalFinding[] {
  return spec.products
    .filter((product) => product.datasheets.length === 0)
    .map((product) => ({
      type: 'product_missing_datasheet',
      specId: spec.specId,
      sourceSpecSection: spec.section,
      productName: product.productName,
      sourceParagraphId: product.source.paragraphId,
    }));
}

export function buildSubmittalFindings(
  specs: readonly SpecSubmittalAnalysis[]
): readonly SubmittalFinding[] {
  return specs.flatMap((spec) => [
    ...productWithoutType(spec),
    ...typeWithoutProduct(spec),
    ...productMissingDatasheet(spec),
  ]);
}
