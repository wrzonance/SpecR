import type { ParagraphAssociation } from '../ast/index.js';

export interface SubmittalProductSource {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly paragraphId: string;
  readonly paragraphText: string;
}

export interface ProductCandidate {
  readonly productName: string;
  readonly source: SubmittalProductSource;
  readonly datasheets: readonly ParagraphAssociation[];
}

export interface SpecSubmittalAnalysis {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly products: readonly ProductCandidate[];
  readonly requiredSubmittalTypes: readonly string[];
}

export interface SubmittalRegisterRow {
  readonly productName: string;
  readonly requiredSubmittalTypes: readonly string[];
  readonly datasheets: readonly ParagraphAssociation[];
  readonly datasheetStatus: 'present' | 'missing';
  readonly sources: readonly SubmittalProductSource[];
}

export type SubmittalFinding =
  | {
      readonly type: 'product_without_submittal_type';
      readonly specId: string;
      readonly sourceSpecSection: string;
      readonly productName: string;
      readonly sourceParagraphId: string;
    }
  | {
      readonly type: 'submittal_type_without_product';
      readonly specId: string;
      readonly sourceSpecSection: string;
      readonly submittalType: string;
    }
  | {
      readonly type: 'product_missing_datasheet';
      readonly specId: string;
      readonly sourceSpecSection: string;
      readonly productName: string;
      readonly sourceParagraphId: string;
    };

export interface SubmittalRegisterSummary {
  readonly rows: number;
  readonly productWithoutSubmittalType: number;
  readonly submittalTypeWithoutProduct: number;
  readonly productMissingDatasheet: number;
  readonly totalFindings: number;
}

export interface SubmittalRegister {
  readonly rows: readonly SubmittalRegisterRow[];
  readonly findings: readonly SubmittalFinding[];
  readonly summary: SubmittalRegisterSummary;
  readonly notes: readonly string[];
}
