import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { getLatestCheckpointBoundary } from './checkpoints.js';
import { SpecNotFoundError } from './edit-gate.js';
import { ProjectNotFoundError } from './derive.js';

// ADR-052 D9 (issue #380, task 8) — pending-change summaries: everything a
// spec (or every spec in a project) has accumulated since its last checkpoint
// — or, if it has never been checkpointed, its whole recorded history. Purely
// additive reads over paragraph_versions + checkpoints; no writes.
//
// Grain: "changed" always means DISTINCT paragraphs, never raw op count — a
// paragraph edited five times since the checkpoint is one pending change, not
// five. This is D3's read-time coalescing principle applied to counting
// instead of session-shaping.
//
// Project scope is `specs.project_id = $1` ONLY (ADR-015 branch membership),
// never `project_specs` — that join table is the package/TOC curation view, a
// different concern (see checkpoints.ts's project-scope insertSql, the same
// precedent). Conflating the two would under/over-count pending work relative
// to the project's actual owned branch.

interface Queryable {
  query: Pool['query'];
}

/** One actor's share of a pending set. `userId: null` covers a legacy
 *  pre-046 row with no attributed user (`actorLabel` reads '(unattributed)')
 *  — every real write resolves to a user row via
 *  paragraph-history.ts's SYSTEM_ACTOR_LABEL fallback, so in practice this is
 *  a backfill-era case, not a live write path. */
export interface PendingActorRollup {
  readonly userId: string | null;
  readonly actorLabel: string;
  readonly changedParagraphCount: number;
}

export interface SpecPendingSummary {
  readonly specId: string;
  readonly sealedByCheckpointId: string | null;
  readonly sealedContentVersion: number | null;
  readonly currentContentVersion: number;
  readonly changedParagraphCount: number;
  readonly actorRollup: readonly PendingActorRollup[];
}

export interface ProjectPendingSummary {
  readonly projectId: string;
  /** Echoed back only (ADR-052 D9: "issuance deadlines are per-package," a
   *  framing hint for the caller) — never used to scope the query. A
   *  project's owned-spec branch membership is unconditional on packageId. */
  readonly packageId: string | null;
  /** Specs with at least one pending (post-seal, or ever-recorded if never
   *  sealed) paragraph — not the project's total spec count. */
  readonly changedSpecCount: number;
  readonly changedParagraphCount: number;
  readonly actorRollup: readonly PendingActorRollup[];
  readonly perSpec: readonly SpecPendingSummary[];
}

interface SpecContentVersionRow {
  readonly content_version: number;
}

interface ProjectSpecRow {
  readonly id: string;
  readonly content_version: number;
}

interface ActorRollupRow {
  readonly user_id: string | null;
  readonly actor_label: string;
  readonly changed_paragraph_count: number;
}

function mapActorRollupRow(row: ActorRollupRow): PendingActorRollup {
  return {
    userId: row.user_id,
    actorLabel: row.actor_label,
    changedParagraphCount: row.changed_paragraph_count,
  };
}

/**
 * Every distinct paragraph with a version past `sealedContentVersion` (or
 * every distinct paragraph the spec has ANY version for, when never sealed —
 * `sealedContentVersion === null`), attributed to the actor who produced its
 * LATEST such version, one row per actor. A NULL `content_version` row
 * (pre-046) can never satisfy `content_version > $2`, so it only ever
 * surfaces in the never-sealed case — the same "never a join target" rule
 * ADR-052 D3 amendment #2 states for session sealing, falling out of plain
 * SQL NULL-comparison semantics here rather than needing its own guard.
 */
async function actorRollupForSpec(
  specId: string,
  sealedContentVersion: number | null,
  db: Queryable
): Promise<readonly PendingActorRollup[]> {
  const result = await db.query<ActorRollupRow>(
    `WITH pending AS (
       SELECT DISTINCT ON (paragraph_id) paragraph_id, user_id
       FROM paragraph_versions
       WHERE spec_id = $1 AND ($2::int IS NULL OR content_version > $2)
       ORDER BY paragraph_id, content_version DESC NULLS LAST, version DESC, id DESC
     )
     SELECT pending.user_id, COALESCE(u.label, '(unattributed)') AS actor_label,
            COUNT(*)::int AS changed_paragraph_count
     FROM pending
     LEFT JOIN users u ON u.id = pending.user_id
     GROUP BY pending.user_id, u.label
     ORDER BY changed_paragraph_count DESC, actor_label ASC`,
    [specId, sealedContentVersion]
  );
  return result.rows.map(mapActorRollupRow);
}

/** Sums the actor rollup's per-actor DISTINCT-paragraph counts. Correct
 *  because {@link actorRollupForSpec}'s `DISTINCT ON` guarantees every
 *  pending paragraph is attributed to exactly one actor bucket, so the sum is
 *  itself a DISTINCT-paragraph count — never proportional to raw op count. */
function totalChangedParagraphs(actorRollup: readonly PendingActorRollup[]): number {
  return actorRollup.reduce((sum, rollup) => sum + rollup.changedParagraphCount, 0);
}

async function buildSpecPendingSummary(
  specId: string,
  currentContentVersion: number,
  db: Queryable
): Promise<SpecPendingSummary> {
  const boundary = await getLatestCheckpointBoundary(specId, db);
  const sealedContentVersion = boundary?.contentVersion ?? null;
  const actorRollup = await actorRollupForSpec(specId, sealedContentVersion, db);
  return {
    specId,
    sealedByCheckpointId: boundary?.checkpointId ?? null,
    sealedContentVersion,
    currentContentVersion,
    changedParagraphCount: totalChangedParagraphs(actorRollup),
    actorRollup,
  };
}

async function specContentVersion(specId: string, db: Queryable): Promise<number | null> {
  const result = await db.query<SpecContentVersionRow>(
    `SELECT content_version FROM specs WHERE id = $1`,
    [specId]
  );
  return result.rows[0]?.content_version ?? null;
}

/** Everything a single spec has accumulated since its last checkpoint (or its
 *  whole recorded history, if never checkpointed). */
export async function getSpecPendingSummary(
  specId: string,
  db: Queryable = pool
): Promise<SpecPendingSummary> {
  try {
    const currentContentVersion = await specContentVersion(specId, db);
    if (currentContentVersion === null) throw new SpecNotFoundError(`spec ${specId} not found`);
    return await buildSpecPendingSummary(specId, currentContentVersion, db);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getSpecPendingSummary failed for spec ${specId}`, { cause: err });
  }
}

async function assertProjectExists(projectId: string, db: Queryable): Promise<void> {
  const result = await db.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if ((result.rowCount ?? 0) === 0) {
    throw new ProjectNotFoundError(`project ${projectId} not found`);
  }
}

/** Direct branch membership (ADR-015) — `specs.project_id = $1`, never the
 *  `project_specs` package/TOC curation join (see module doc comment). */
async function projectSpecRows(
  projectId: string,
  db: Queryable
): Promise<readonly ProjectSpecRow[]> {
  const result = await db.query<ProjectSpecRow>(
    `SELECT id, content_version FROM specs WHERE project_id = $1 ORDER BY section, id`,
    [projectId]
  );
  return result.rows;
}

/** Folds every per-spec actor rollup into one project-wide total per actor —
 *  pure, builds a fresh accumulator, never mutates any input summary. */
function mergeActorRollups(perSpec: readonly SpecPendingSummary[]): readonly PendingActorRollup[] {
  const totals = new Map<string, PendingActorRollup>();
  for (const spec of perSpec) {
    for (const rollup of spec.actorRollup) {
      const key = rollup.userId ?? '(unattributed)';
      const existing = totals.get(key);
      totals.set(key, {
        userId: rollup.userId,
        actorLabel: rollup.actorLabel,
        changedParagraphCount:
          (existing?.changedParagraphCount ?? 0) + rollup.changedParagraphCount,
      });
    }
  }
  return [...totals.values()].sort(
    (a, b) =>
      b.changedParagraphCount - a.changedParagraphCount || a.actorLabel.localeCompare(b.actorLabel)
  );
}

/**
 * Everything every spec directly owned by `projectId` (ADR-015 branch
 * membership, `specs.project_id` — never `project_specs`) has accumulated
 * since ITS OWN last checkpoint. `packageId` is echoed back for the caller's
 * own issuance-deadline framing (ADR-052 D9) — it never scopes the query.
 */
export async function getProjectPendingSummary(
  projectId: string,
  packageId?: string,
  db: Queryable = pool
): Promise<ProjectPendingSummary> {
  try {
    await assertProjectExists(projectId, db);
    const specs = await projectSpecRows(projectId, db);
    const perSpec: SpecPendingSummary[] = [];
    for (const spec of specs) {
      perSpec.push(await buildSpecPendingSummary(spec.id, spec.content_version, db));
    }
    return {
      projectId,
      packageId: packageId ?? null,
      changedSpecCount: perSpec.filter((spec) => spec.changedParagraphCount > 0).length,
      changedParagraphCount: perSpec.reduce((sum, spec) => sum + spec.changedParagraphCount, 0),
      actorRollup: mergeActorRollups(perSpec),
      perSpec,
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getProjectPendingSummary failed for project ${projectId}`, {
      cause: err,
    });
  }
}
