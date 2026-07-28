// Sub-barrel extracted from db/index.ts (ADR-079 decision 12): that file was
// already at ESLint's max-lines: 400 ceiling on main, and the issuance-
// readiness exports below do not fit as additions. This groups (a) the
// pre-existing open-comments re-exports, mechanically moved here with their
// names unchanged, and (b) every new readiness-report/readiness-gate/
// readiness-review export. db/index.ts re-exports this whole module with a
// single `export * from './index-readiness.js'` — every consumer still
// imports from `'../db/index.js'`; only where the statements live moved.

export { getOpenCommentsReport } from './queries/open-comments.js';
export type {
  OpenComment,
  OpenCommentsScope,
  OpenCommentsSummary,
  OpenCommentsReport,
} from './queries/open-comments.js';

// ADR-079 (#406) — issuance-readiness gate + its read-only report surface.
// `assertReadyForFinal` is re-exported here (not given a bespoke direct
// import path) so `src/api/**` can reach it through the barrel per the
// sibling-barrel-only module-boundary rule (ADR-079 decision 13).
export { assertReadyForFinal, ReadinessBlockedError } from './queries/readiness-gate.js';
export {
  evaluateSpecReadiness,
  summarizeReadinessFindings,
  type ReadinessFindingKind,
  type ReadinessFinding,
  type UnresolvedChoiceTokenFinding,
  type SpecifierNotePresentFinding,
  type OpenCommentFinding,
  type BodyObjectPresentFinding,
  type ReadinessSummary,
  type SpecReadinessResult,
} from '../lib/readiness-review.js';
export {
  getReadinessReport,
  type ReadinessScope,
  type ReadinessReport,
  type StampedReadinessFinding,
  type StampedHighlightAdvisory,
} from './queries/readiness-report.js';
