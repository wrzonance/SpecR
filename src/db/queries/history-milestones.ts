import type { Queryable } from './history.js';

// The dated markers a spec's history timeline hangs off: where the spec came
// from (origin), every issuance that froze it (revision), and every review
// checkpoint that sealed it (checkpoint, ADR-052 D3/D9). Split out of
// history.ts so the timeline's marker vocabulary and its two reads live
// together, apart from the paragraph/step machinery.

export type SpecHistoryMilestone =
  | {
      readonly kind: 'origin';
      readonly at: string;
      readonly parentSpecId: string | null;
      readonly originVersion: number;
    }
  | {
      readonly kind: 'revision';
      readonly at: string;
      readonly revisionId: string;
      readonly packageId: string;
      readonly label: string;
    }
  | {
      readonly kind: 'checkpoint';
      readonly at: string;
      readonly checkpointId: string;
      readonly name: string;
      readonly contentVersion: number;
    };

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface RevisionMilestoneRow {
  readonly revision_id: string;
  readonly package_id: string;
  readonly label: string;
  readonly issued_at: Date;
}

export async function revisionMilestones(
  specId: string,
  packageId: string | undefined,
  db: Queryable
): Promise<readonly SpecHistoryMilestone[]> {
  const result = await db.query<RevisionMilestoneRow>(
    `SELECT pr.id AS revision_id, pr.package_id, pr.label, pr.issued_at
     FROM package_revision_specs prs
     JOIN package_revisions pr ON pr.id = prs.revision_id
     WHERE prs.spec_id = $1 AND ($2::uuid IS NULL OR pr.package_id = $2)
     ORDER BY pr.issued_at, pr.id`,
    [specId, packageId ?? null]
  );
  return result.rows.map((row) => ({
    kind: 'revision',
    at: iso(row.issued_at),
    revisionId: row.revision_id,
    packageId: row.package_id,
    label: row.label,
  }));
}

interface CheckpointMilestoneRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly content_version: number;
}

/** Checkpoints applying to `specId` (own + covering project-scoped),
 *  ascending — own query rather than getCheckpointBoundariesForSpec because
 *  the timeline also needs the checkpoint's `name`. $1::uuid::text (not a bare
 *  $1::text, #380 review finding) canonicalizes specId's letter-casing before
 *  it's compared against the jsonb keys — mirrors checkpoints.ts's own
 *  boundary queries, so this duplicated read path can't regress separately. */
export async function checkpointMilestones(
  specId: string,
  db: Queryable
): Promise<readonly SpecHistoryMilestone[]> {
  const result = await db.query<CheckpointMilestoneRow>(
    `SELECT id, name, created_at, (content_version_map ->> $1::uuid::text)::int AS content_version
     FROM checkpoints
     WHERE content_version_map ? $1::uuid::text
     ORDER BY content_version ASC, created_at ASC, id ASC`,
    [specId]
  );
  return result.rows.map((row) => ({
    kind: 'checkpoint',
    at: iso(row.created_at),
    checkpointId: row.id,
    name: row.name,
    contentVersion: row.content_version,
  }));
}
