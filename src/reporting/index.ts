export { buildComparisonReport } from './report.js';
export { alignTrees, projectBaseline } from './align.js';
export { ReportingError, SpecNotFoundError } from './error.js';
export { CompareRequestSchema } from './types.js';
export type {
  CompareRequest,
  ComparisonColumn,
  ComparisonParagraph,
  AlignSource,
  ComparisonCell,
  ComparisonMatrixRow,
  ComparisonMatrix,
  CellState,
  BaselineLensRow,
  BaselineLens,
  DriftEntry,
  ComparisonReport,
} from './types.js';
