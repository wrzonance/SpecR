import type { PoolClient } from 'pg';
import { DatabaseError } from '../errors.js';

// ADR-066 — package revision custody. parent_revision_id is the revision
// this one was issued FROM (git-tag-like lineage). Two invariants are
// enforced here, at the query layer rather than a DB CHECK (ADR-025 thin
// spine): a non-null parent must belong to the SAME package_revisions.
// package_id as the child, and nesting depth never exceeds 1 (a parent must
// itself be a root revision — no grandparents).

/** The parent candidate row this rule check needs: enough to decide
 *  same-package and depth, nothing else. `null` means "no such revision". */
export interface ParentRevisionCandidate {
  readonly packageId: string;
  readonly parentRevisionId: string | null;
}

/** A requested parent_revision_id failed one of the custody invariants:
 *  not found, cross-package, or nesting depth > 1. Surfaces as 422 at the
 *  API/MCP boundary. */
export class RevisionParentValidationError extends DatabaseError {}

/** Pure rule check — no DB, no env. `parentRevisionId === null` is always a
 *  no-op (no parent requested). Otherwise `candidate` must be the row
 *  fetched for that id: `null` if it does not exist. */
export function checkParentRevisionRules(
  targetPackageId: string,
  parentRevisionId: string | null,
  candidate: ParentRevisionCandidate | null
): void {
  if (parentRevisionId === null) return;
  if (candidate === null) {
    throw new RevisionParentValidationError(`parent revision ${parentRevisionId} not found`);
  }
  // Case-fold: Postgres canonicalizes uuid columns to lowercase on read, so
  // `candidate.packageId` (fetched from the DB) is always lowercase, while
  // `targetPackageId` is the route-param string passed through as typed —
  // an uppercase/mixed-case UUID in the URL must still compare equal.
  if (candidate.packageId.toLowerCase() !== targetPackageId.toLowerCase()) {
    throw new RevisionParentValidationError(
      `parent revision ${parentRevisionId} belongs to a different package`
    );
  }
  if (candidate.parentRevisionId !== null) {
    throw new RevisionParentValidationError(
      `parent revision ${parentRevisionId} already has a parent — nesting depth cannot exceed 1`
    );
  }
}

interface ParentRevisionRow {
  readonly package_id: string;
  readonly parent_revision_id: string | null;
}

/** I/O wrapper: fetches the candidate parent row inside the caller's
 *  transaction (so it sees the caller's locks/isolation level) and
 *  delegates to the pure rule check. No-op when `parentRevisionId` is
 *  null. */
export async function assertValidParentRevision(
  targetPackageId: string,
  parentRevisionId: string | null,
  client: PoolClient
): Promise<void> {
  if (parentRevisionId === null) return;
  const result = await client.query<ParentRevisionRow>(
    'SELECT package_id, parent_revision_id FROM package_revisions WHERE id = $1',
    [parentRevisionId]
  );
  const row = result.rows[0];
  const candidate: ParentRevisionCandidate | null = row
    ? { packageId: row.package_id, parentRevisionId: row.parent_revision_id }
    : null;
  checkParentRevisionRules(targetPackageId, parentRevisionId, candidate);
}
