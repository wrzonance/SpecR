export { MergeError } from './error.js';
export { computeDiff } from './diff.js';
export { computeSpecDiff } from './spec-diff.js';
export { applyAccepted, InvalidAcceptedChangeError } from './conflict.js';
export type { ApplyAcceptedResult } from './conflict.js';
export { applyMerge } from './apply-merge.js';
export type { ApplyMergeOutcome } from './apply-merge.js';
export type { DiffOptions } from './diff.js';
export { extractContentControls } from './extract.js';
export type {
  ParagraphSnapshot,
  TrackChangeRecord,
  ExtractResult,
  ParagraphDiff,
  ModifiedDiff,
  ConflictDiff,
  DiffResult,
  UuidGen,
} from './types.js';
