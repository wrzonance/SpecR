import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';

// ADR-052 D6 — actor identity substrate (version-history program, #381). `users` is a bare
// identity: label-claimed today (spoofable, stated openly in the MCP tool description),
// externally-associated next (Revit username mapping), SSO-verified after #43.
// role_assignments (migration 045) ships schema-only — its query/REST/MCP layer is deferred
// to a follow-up PR.

interface Queryable {
  query: Pool['query'];
}

export interface UserSummary {
  readonly id: string;
  readonly label: string;
  readonly createdAt: Date;
}

interface UserRow {
  readonly id: string;
  readonly label: string;
  readonly created_at: Date;
}

const USER_COLUMNS = 'id, label, created_at';

function mapUserRow(row: UserRow): UserSummary {
  return { id: row.id, label: row.label, createdAt: row.created_at };
}

/**
 * Resolve a user by exact-match label, creating one if none exists yet. Idempotent and
 * race-free under concurrent calls for the same label (single upsert statement, not a
 * check-then-insert): the `users_label_unique` constraint (migration 045) backs an
 * ON CONFLICT DO UPDATE, so two racing calls for the same label both resolve to the same row.
 * Trusts the caller has already trimmed/bounded `label` (Zod boundary at the REST/MCP edge) —
 * does not re-trim itself.
 */
export async function resolveOrCreateUserByLabel(
  label: string,
  db: Queryable = pool
): Promise<UserSummary> {
  try {
    const result = await db.query<UserRow>(
      `INSERT INTO users (label) VALUES ($1)
       ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
       RETURNING ${USER_COLUMNS}`,
      [label]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('resolveOrCreateUserByLabel: no row returned after upsert');
    return mapUserRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    // Deliberately omit `label` from the message: it is claimed actor identity (potentially an
    // email) and this error reaches logger.error at the REST/MCP edge — the pg cause is chained
    // internally for debugging without persisting the identifier to logs.
    throw new DatabaseError('resolveOrCreateUserByLabel: upsert failed', { cause: err });
  }
}

export async function listUsers(db: Queryable = pool): Promise<readonly UserSummary[]> {
  try {
    const result = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY label, id`);
    return result.rows.map(mapUserRow);
  } catch (err) {
    throw new DatabaseError('listUsers: query failed', { cause: err });
  }
}

/** Absent row -> null; the REST/MCP layers translate that to 404/not-found, never a throw. */
export async function getUser(id: string, db: Queryable = pool): Promise<UserSummary | null> {
  try {
    const result = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapUserRow(row) : null;
  } catch (err) {
    // Keep the requested id out of the message (it reaches logger.error at the edge) for a
    // uniform error posture with resolveOrCreateUserByLabel; the pg cause is chained internally.
    throw new DatabaseError('getUser: query failed', { cause: err });
  }
}
