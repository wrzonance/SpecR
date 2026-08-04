import type { Pool } from 'pg';
import { DatabaseError } from '../db/errors.js';

/**
 * Ids an integration test captured at insert time, for FK-safe id-scoped
 * teardown instead of a name/pattern-based `DELETE` that could also match
 * (and destroy) a concurrent invocation's fixtures (#638, ADR-090). Every
 * field is optional; an omitted or empty array is a true no-op for that
 * table's `DELETE`.
 */
export interface CapturedFixtureIds {
  readonly specIds?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly libraryIds?: readonly string[];
}

/**
 * Deletes exactly the rows a test captured, in FK-safe order: specs first
 * (they reference both projects and libraries), then projects, then
 * libraries. Never touches a row this test did not insert.
 */
export async function deleteCapturedFixtures(pool: Pool, ids: CapturedFixtureIds): Promise<void> {
  try {
    if (ids.specIds?.length) {
      await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [ids.specIds]);
    }
    if (ids.projectIds?.length) {
      await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [ids.projectIds]);
    }
    if (ids.libraryIds?.length) {
      await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [ids.libraryIds]);
    }
  } catch (err) {
    throw new DatabaseError('failed to delete captured integration-test fixtures', { cause: err });
  }
}
