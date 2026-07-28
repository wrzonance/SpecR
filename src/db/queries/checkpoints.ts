import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { getPgCode } from '../../lib/pg-errors.js';

// ADR-052 D3/D4 (issue #380) — the checkpoints query layer over migration 052's
// table. A checkpoint is a stored named marker sealing a spec (or every spec in
// a project) as of a `content_version` snapshot taken atomically at INSERT
// time (see insertSql below) — never re-read live, so a later edit to the
// underlying spec(s) can never retroactively change a sealed checkpoint's
// recorded versions (D2 never-squash extended to tier 1).
//
// D3 amendment (2026-07-27 design spike): `contentVersion`, not the
// paragraph-local `ParagraphHistoryEntry.version`, is the join key the
// coalescer (getCheckpointBoundariesForSpec / getLatestCheckpointBoundary)
// exposes — see docs/adr/052-version-history-review-grain-identity.md.

interface Queryable {
  query: Pool['query'];
}

export type CheckpointScope = 'spec' | 'project';

/** JSONB object of `{ [specId]: contentVersion }`, snapshotted once at
 *  checkpoint creation. A spec-scoped checkpoint's map has exactly one key
 *  (its own spec); a project-scoped checkpoint's map has one key per spec
 *  that was in-scope (`specs.project_id = projectId`) at seal time. */
export interface ContentVersionMap {
  readonly [specId: string]: number;
}

export interface Checkpoint {
  readonly id: string;
  readonly name: string;
  readonly scope: CheckpointScope;
  readonly scopeId: string;
  readonly userId: string;
  readonly contentVersionMap: ContentVersionMap;
  readonly createdAt: string;
}

export interface CreateCheckpointInput {
  readonly name: string;
  readonly scope: CheckpointScope;
  readonly scopeId: string;
  readonly userId: string;
}

/** The coalescer's exact join-key shape (ADR-052 D3 amendment #1):
 *  `contentVersion`, never a paragraph-local version. */
export interface CheckpointBoundary {
  readonly checkpointId: string;
  readonly at: string;
  readonly contentVersion: number;
}

/** createCheckpoint was given a spec/project scopeId with no matching row
 *  (surfaces as an FK 23503 violation on spec_id/project_id) → 404 at the
 *  handler. Mirrors ClientLibraryNotFoundError / DivisionGeneralOwnerNotFoundError. */
export class CheckpointScopeNotFoundError extends DatabaseError {}

interface CheckpointRow {
  readonly id: string;
  readonly name: string;
  readonly spec_id: string | null;
  readonly project_id: string | null;
  readonly user_id: string;
  readonly content_version_map: ContentVersionMap;
  readonly created_at: Date;
}

interface CheckpointBoundaryRow {
  readonly id: string;
  readonly created_at: Date;
  readonly content_version: number;
}

const CHECKPOINT_COLUMNS =
  'id, name, spec_id, project_id, user_id, content_version_map, created_at';

function iso(value: Date): string {
  return value.toISOString();
}

function scopeColumn(scope: CheckpointScope): 'spec_id' | 'project_id' {
  return scope === 'spec' ? 'spec_id' : 'project_id';
}

function mapCheckpointRow(row: CheckpointRow): Checkpoint {
  const scope: CheckpointScope = row.spec_id !== null ? 'spec' : 'project';
  const scopeId = row.spec_id ?? row.project_id;
  // checkpoints_scope_xor (migration 052) guarantees Postgres never persists a
  // row with both/neither set — unreachable in practice, but a typed throw
  // beats a silent non-null assertion if that invariant is ever violated.
  if (scopeId === null) {
    throw new DatabaseError(`checkpoint ${row.id}: neither spec_id nor project_id is set`);
  }
  return {
    id: row.id,
    name: row.name,
    scope,
    scopeId,
    userId: row.user_id,
    contentVersionMap: row.content_version_map,
    createdAt: iso(row.created_at),
  };
}

function mapBoundaryRow(row: CheckpointBoundaryRow): CheckpointBoundary {
  return { checkpointId: row.id, at: iso(row.created_at), contentVersion: row.content_version };
}

/**
 * One atomic snapshot-and-insert statement per scope — the content_version(s)
 * are read from `specs` in the SAME statement that seals them into
 * content_version_map, so there is no read-then-write race window in which a
 * concurrent content write could land between the snapshot read and the
 * checkpoint insert. An unknown scopeId hits the spec_id/project_id FK
 * (checkpoints references specs/projects with ON DELETE CASCADE) and raises
 * 23503, remapped to CheckpointScopeNotFoundError by createCheckpoint.
 */
function insertSql(scope: CheckpointScope): string {
  // Every occurrence of $2 casts explicitly (::uuid or ::text). Postgres infers
  // one global type per parameter across a whole statement — leaving even one
  // occurrence unadorned while another casts it (e.g. to ::text for the jsonb
  // key) makes the server unify on that cast type everywhere, turning the
  // plain `spec_id`/`project_id` column assignment into a `uuid = text`
  // operator error. Explicit casts at every site route around that inference.
  if (scope === 'spec') {
    return `INSERT INTO checkpoints (name, spec_id, user_id, content_version_map)
      VALUES (
        $1, $2::uuid, $3,
        jsonb_build_object($2::text, (SELECT content_version FROM specs WHERE id = $2::uuid))
      )
      RETURNING ${CHECKPOINT_COLUMNS}`;
  }
  return `INSERT INTO checkpoints (name, project_id, user_id, content_version_map)
    VALUES (
      $1, $2::uuid, $3,
      (SELECT COALESCE(jsonb_object_agg(id::text, content_version), '{}'::jsonb)
         FROM specs WHERE project_id = $2::uuid)
    )
    RETURNING ${CHECKPOINT_COLUMNS}`;
}

/** Seal a spec (or every spec in a project) at its current content_version(s).
 *  Never mutated after creation — the returned contentVersionMap is the
 *  permanent record of what "reviewed" meant at this moment. */
export async function createCheckpoint(
  input: CreateCheckpointInput,
  db: Queryable = pool
): Promise<Checkpoint> {
  try {
    const result = await db.query<CheckpointRow>(insertSql(input.scope), [
      input.name,
      input.scopeId,
      input.userId,
    ]);
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createCheckpoint: no row returned after insert');
    return mapCheckpointRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    const wrapped = new DatabaseError(
      `createCheckpoint: insert failed for ${input.scope} ${input.scopeId}`,
      { cause: err }
    );
    if (getPgCode(wrapped) === '23503') {
      throw new CheckpointScopeNotFoundError(`${input.scope} ${input.scopeId} not found`, {
        cause: err,
      });
    }
    throw wrapped;
  }
}

/** Checkpoints created directly against `scopeId`, most recent first. Does
 *  NOT include project-scoped checkpoints for a spec's own project when
 *  scope: 'spec' — use getCheckpointBoundariesForSpec for "every checkpoint
 *  that sealed this spec, spec- or project-scoped alike". */
export async function listCheckpoints(
  scope: CheckpointScope,
  scopeId: string,
  db: Queryable = pool
): Promise<readonly Checkpoint[]> {
  try {
    const result = await db.query<CheckpointRow>(
      `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE ${scopeColumn(scope)} = $1
       ORDER BY created_at DESC, id DESC`,
      [scopeId]
    );
    return result.rows.map(mapCheckpointRow);
  } catch (err) {
    throw new DatabaseError(`listCheckpoints: query failed for ${scope} ${scopeId}`, {
      cause: err,
    });
  }
}

export async function getCheckpointById(
  id: string,
  db: Queryable = pool
): Promise<Checkpoint | null> {
  try {
    const result = await db.query<CheckpointRow>(
      `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapCheckpointRow(row) : null;
  } catch (err) {
    throw new DatabaseError(`getCheckpointById: query failed for ${id}`, { cause: err });
  }
}

/** Every checkpoint boundary that applies to `specId`, ascending by
 *  contentVersion — the coalescer's exact input shape. A checkpoint "applies
 *  to" a spec iff its content_version_map carries that spec's id as a key:
 *  true for a spec-scoped checkpoint's own spec, and for every spec that was
 *  in-scope for a project-scoped checkpoint at seal time. A spec added to the
 *  project AFTER a given checkpoint correctly has no boundary from it. */
export async function getCheckpointBoundariesForSpec(
  specId: string,
  db: Queryable = pool
): Promise<readonly CheckpointBoundary[]> {
  try {
    const result = await db.query<CheckpointBoundaryRow>(
      `SELECT id, created_at, (content_version_map ->> $1::text)::int AS content_version
       FROM checkpoints
       WHERE content_version_map ? $1::text
       ORDER BY content_version ASC, created_at ASC, id ASC`,
      [specId]
    );
    return result.rows.map(mapBoundaryRow);
  } catch (err) {
    throw new DatabaseError(`getCheckpointBoundariesForSpec: query failed for ${specId}`, {
      cause: err,
    });
  }
}

/** The single most-recent boundary for `specId` by contentVersion (ties
 *  broken by created_at then id) — always equal to
 *  `(await getCheckpointBoundariesForSpec(specId)).at(-1)`, kept as its own
 *  LIMIT 1 query so a caller that only needs "is this spec sealed, and as of
 *  what contentVersion" skips materializing the full boundary list. */
export async function getLatestCheckpointBoundary(
  specId: string,
  db: Queryable = pool
): Promise<CheckpointBoundary | null> {
  try {
    const result = await db.query<CheckpointBoundaryRow>(
      `SELECT id, created_at, (content_version_map ->> $1::text)::int AS content_version
       FROM checkpoints
       WHERE content_version_map ? $1::text
       ORDER BY content_version DESC, created_at DESC, id DESC
       LIMIT 1`,
      [specId]
    );
    const row = result.rows[0];
    return row ? mapBoundaryRow(row) : null;
  } catch (err) {
    throw new DatabaseError(`getLatestCheckpointBoundary: query failed for ${specId}`, {
      cause: err,
    });
  }
}
