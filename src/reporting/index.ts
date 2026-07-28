export { buildComparisonReport } from './report.js';
export { alignTrees, projectBaseline } from './align.js';
export { computeStructuralKeys } from './structure.js';
export { summarize, filterToDifferences } from './summary.js';
export { ReportingError, SpecNotFoundError } from './error.js';
export {
  CompareRequestSchema,
  CompareSourceSchema,
  sourceSpecId,
  isFrozenSource,
} from './types.js';
export type {
  CompareRequest,
  CompareSource,
  AlignmentMode,
  AlignmentRequest,
  ComparisonColumn,
  ComparisonParagraph,
  AlignSource,
  ComparisonCell,
  ComparisonMatrixRow,
  ComparisonMatrix,
  CellState,
  BaselineLensRow,
  BaselineLens,
  ComparisonSummaryColumn,
  ComparisonSummary,
  DriftEntry,
  ComparisonReport,
} from './types.js';
