import { SnapshotValidationError } from './revisions.js';
import { RevisionNomenclatureValidationError } from './revision-identity.js';
import { RevisionParentValidationError } from './revision-parent.js';
import { RevisionComparisonError } from './revision-comparison.js';
import { ReadinessBlockedError } from './readiness-gate.js';

/** True for the create-revision errors that mean the *input* is unprocessable —
 *  a member tree that can't be snapshotted losslessly, a type outside the
 *  project's nomenclature profile, a revision relationship that fails its
 *  invariant, or (ADR-079, #406) a `mode: 'final'` issuance blocked by
 *  outstanding readiness findings — as opposed to a 500 DB/integrity fault.
 *  The API and MCP create-revision handlers both map this set to
 *  422 / toolError; keeping the set in one predicate is what keeps the two
 *  boundaries in sync as it grows — add a new class here once and both call
 *  sites follow. */
export function isUnprocessableRevisionInputError(
  err: unknown
): err is
  | SnapshotValidationError
  | RevisionNomenclatureValidationError
  | RevisionParentValidationError
  | RevisionComparisonError
  | ReadinessBlockedError {
  return (
    err instanceof SnapshotValidationError ||
    err instanceof RevisionNomenclatureValidationError ||
    err instanceof RevisionParentValidationError ||
    err instanceof RevisionComparisonError ||
    err instanceof ReadinessBlockedError
  );
}
