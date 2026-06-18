import type { Pool } from 'pg';
import { DatabaseError } from '../errors.js';

/** ADR-018 D1 + D3 — the composed edit gate.
 *
 * Every content write passes through here before mutating paragraphs. The gate
 * answers two questions in one row-locked read:
 *
 *   1. May this spec be edited at all? — native `lifecycle_state` AND external
 *      `external_state` (ADR-014 D5) must BOTH permit. 'archived' is read-only;
 *      'issued' still edits (the issued *snapshot* is the immutable thing).
 *      `external_state` must be 'editable' (a spec locked upstream in a DMS
 *      cannot be edited locally until released).
 *   2. Is the caller writing against the version they read? — optimistic
 *      concurrency: a stale `expectedVersion` fails rather than silently
 *      clobbering a concurrent write (lost-update prevention without locking).
 *
 * Always call inside the write transaction: the `FOR UPDATE` lock it takes is
 * what serializes the check against a concurrent write on the same spec. */

/** The spec does not exist (→ 404). */
export class SpecNotFoundError extends DatabaseError {}

/** Lifecycle or external state forbids the write (→ 409). */
export class SpecWriteForbiddenError extends DatabaseError {}

/** The caller's `expectedVersion` is behind the current `content_version`
 *  (→ 409). The current version travels on the error so the client can refetch
 *  and retry without a second round-trip. */
export class StaleVersionError extends DatabaseError {
  readonly currentVersion: number;
  constructor(message: string, currentVersion: number, options?: ErrorOptions) {
    super(message, options);
    this.currentVersion = currentVersion;
  }
}

interface Queryable {
  query: Pool['query'];
}

interface GateRow {
  readonly lifecycle_state: string;
  readonly external_state: string;
  readonly content_version: number;
}

/** External states that permit a local write. The enum is ADR-014 D5's closed
 *  set; only 'editable' is writable — every governed state (locked / pending
 *  review / retained / read-only) blocks. */
const WRITABLE_EXTERNAL_STATE = 'editable';

/** Assert the spec is writable and (optionally) at the expected version.
 *  Returns the current `content_version` so callers can bump it. Throws a
 *  typed error otherwise. Must run inside the write transaction. */
export async function assertSpecWritable(
  db: Queryable,
  specId: string,
  expectedVersion?: number
): Promise<{ readonly contentVersion: number }> {
  const result = await db.query<GateRow>(
    `SELECT lifecycle_state, external_state, content_version
     FROM specs WHERE id = $1 FOR UPDATE`,
    [specId]
  );
  const row = result.rows[0];
  if (!row) throw new SpecNotFoundError(`assertSpecWritable: spec ${specId} not found`);

  if (row.lifecycle_state === 'archived') {
    throw new SpecWriteForbiddenError('spec is archived and cannot be edited');
  }
  if (row.external_state !== WRITABLE_EXTERNAL_STATE) {
    throw new SpecWriteForbiddenError(
      `spec is not editable: upstream state is "${row.external_state}"`
    );
  }
  if (expectedVersion !== undefined && expectedVersion !== row.content_version) {
    throw new StaleVersionError(
      `stale write: expected version ${expectedVersion}, current is ${row.content_version}`,
      row.content_version
    );
  }
  return { contentVersion: row.content_version };
}
