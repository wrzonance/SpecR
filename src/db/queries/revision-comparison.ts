import type { PoolClient } from 'pg';
import { DatabaseError } from '../errors.js';

/** A requested comparison base is missing or belongs to another package. */
export class RevisionComparisonError extends DatabaseError {}

interface BaseRevisionRow {
  readonly package_id: string;
}

/** Validate persisted comparison lineage inside the issuance transaction. */
export async function assertValidBaseRevision(
  targetPackageId: string,
  baseRevisionId: string | null,
  client: PoolClient
): Promise<void> {
  if (baseRevisionId === null) return;
  const result = await client.query<BaseRevisionRow>(
    'SELECT package_id FROM package_revisions WHERE id = $1',
    [baseRevisionId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new RevisionComparisonError(`addendum base revision ${baseRevisionId} not found`);
  }
  if (row.package_id.toLowerCase() !== targetPackageId.toLowerCase()) {
    throw new RevisionComparisonError('addendum base revision belongs to a different package');
  }
}
