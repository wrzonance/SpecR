import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { logger } from '../../lib/logger.js';
import { RevisionAttributesSchema } from '../../ast/index.js';
import type { RevisionAttributes, IssuanceMode } from '../../ast/index.js';
import { snapshotMemberTrees, insertSnapshotRows, validateTree } from './revision-snapshot.js';
import type { RevisionSpecEntry } from './revision-snapshot.js';
import { PackageNotFoundError } from './packages.js';
import { getRevisionNomenclatureForProject } from './revision-nomenclature.js';
import type { RevisionNomenclatureProfile } from './revision-nomenclature.js';
import { createRevisionIdentityDraft, getRevisionDisplayIdentity } from './revision-identity.js';
import type { CreatePackageRevisionInput } from './revision-identity.js';
import { assertValidParentRevision } from './revision-parent.js';
import { assertValidBaseRevision, RevisionComparisonError } from './revision-comparison.js';
import { changedRevisionSpecs } from './revision-diff.js';
import { assertReadyForFinal } from './readiness-gate.js';
export { RevisionNomenclatureValidationError } from './revision-identity.js';
export { RevisionParentValidationError } from './revision-parent.js';
export { RevisionComparisonError } from './revision-comparison.js';
export { SnapshotValidationError } from './revision-snapshot.js';
export type { RevisionSpecEntry } from './revision-snapshot.js';
// ADR-079 (#406): re-exported here so this file stays the one place
// `db/index.ts` reaches for revision-issuance error classes — matching the
// four sibling re-exports above (SnapshotValidationError et al.), all
// DatabaseError subclasses representing a business-rule refusal.
export { ReadinessBlockedError } from './readiness-gate.js';

/** Package revisions (ADR-015 D5, issue #96): immutable issuance snapshots.
 *  Issuing freezes every member section's full SpecTree as JSONB inside one
 *  REPEATABLE READ transaction, so all trees come from a single consistent
 *  point-in-time view. Trees are Zod-validated at write (never freeze a
 *  snapshot that cannot round-trip) and again at read (tamper/drift guard).
 *  Issuing also flips each draft member spec to lifecycle_state='issued'
 *  (ADR-018 D3 hook — see markMembersIssued). */

interface Queryable {
  query: Pool['query'];
}

export interface RevisionSummary {
  readonly revisionId: string;
  readonly packageId: string;
  readonly label: string;
  readonly displayName: string;
  readonly type: string;
  readonly date: string;
  readonly sortOrder: number;
  readonly number: string | null;
  readonly attributes: RevisionAttributes;
  readonly issuedAt: string;
  readonly specCount: number;
  readonly parentRevisionId: string | null;
  readonly baseRevisionId: string | null;
}

export interface RevisionWithTrees {
  readonly revisionId: string;
  readonly packageId: string;
  readonly label: string;
  readonly displayName: string;
  readonly type: string;
  readonly date: string;
  readonly sortOrder: number;
  readonly number: string | null;
  readonly attributes: RevisionAttributes;
  readonly issuedAt: string;
  readonly specs: readonly RevisionSpecEntry[];
  readonly parentRevisionId: string | null;
  readonly baseRevisionId: string | null;
}

export interface RevisionManualData {
  readonly revision: RevisionWithTrees;
  readonly project: {
    readonly name: string;
    readonly description: string | null;
  };
  readonly designPackage: {
    readonly packageId: string;
    readonly name: string;
  };
}

export interface RevisionAddendumManualData extends RevisionManualData {
  readonly baseRevisionId: string;
  readonly changedSpecs: readonly RevisionSpecEntry[];
}

export interface RevisionRow {
  readonly id: string;
  readonly package_id: string;
  readonly label: string;
  readonly revision_type: string;
  readonly revision_date: string;
  readonly sort_order: number;
  readonly attributes: unknown;
  readonly issued_at: Date;
  readonly parent_revision_id: string | null;
  readonly base_revision_id: string | null;
}

interface PackageRow {
  readonly project_id: string;
}

interface SnapshotRow {
  readonly spec_id: string;
  readonly position: number;
  readonly tree: unknown;
}

interface RevisionContextRow {
  readonly package_id: string;
  readonly package_name: string;
  readonly project_name: string;
  readonly project_description: string | null;
}

async function lockPackage(packageId: string, client: PoolClient): Promise<PackageRow> {
  const res = await client.query<PackageRow>(
    'SELECT project_id FROM design_packages WHERE id = $1 FOR UPDATE',
    [packageId]
  );
  const row = res.rows[0];
  if (!row) {
    throw new PackageNotFoundError(`createPackageRevision: package ${packageId} not found`);
  }
  return row;
}

/** ADR-018 D3 issuance hook: a spec that participates in a package revision
 *  becomes 'issued'. Only 'draft' specs flip — 'issued' stays issued, and
 *  'archived' is never reactivated by issuance. Editing of an issued spec stays
 *  allowed (the snapshot is the immutable thing); the state is advisory. */
async function markMembersIssued(specIds: readonly string[], client: PoolClient): Promise<void> {
  if (specIds.length === 0) return;
  await client.query(
    `UPDATE specs SET lifecycle_state = 'issued', updated_at = now()
     WHERE id = ANY($1) AND lifecycle_state = 'draft'`,
    [specIds]
  );
}

async function nextSortOrder(packageId: string, client: PoolClient): Promise<number> {
  const result = await client.query<{ next_sort_order: number }>(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort_order
     FROM package_revisions WHERE package_id = $1`,
    [packageId]
  );
  return result.rows[0]?.next_sort_order ?? 1;
}

function revisionDateString(value: string | Date): string {
  if (typeof value === 'string') return value;
  return value.toISOString().slice(0, 10);
}

function parseAttributes(candidate: unknown): RevisionAttributes {
  return RevisionAttributesSchema.parse(candidate);
}

interface ReadinessGateInput {
  readonly mode: IssuanceMode | undefined;
  readonly overrideReadinessGate: boolean | undefined;
}

/** ADR-079 (#406): pulls the two issuance-readiness-gate inputs out of either
 *  accepted `createPackageRevision` shape. Extracted purely to keep
 *  `createPackageRevision` under this repo's `max-lines-per-function`/
 *  `complexity` budgets — functionally identical to inlining the same
 *  destructure. The legacy string body never carries either field. */
function readinessInputFrom(input: string | CreatePackageRevisionInput): ReadinessGateInput {
  if (typeof input === 'string') return { mode: undefined, overrideReadinessGate: undefined };
  return { mode: input.mode, overrideReadinessGate: input.overrideReadinessGate };
}

export function mapSummary(
  row: RevisionRow,
  profile: RevisionNomenclatureProfile | null,
  specCount: number
): RevisionSummary {
  const date = revisionDateString(row.revision_date);
  const attributes = parseAttributes(row.attributes);
  const display = getRevisionDisplayIdentity(
    row.revision_type,
    attributes,
    profile,
    row.label,
    date
  );
  return {
    revisionId: row.id,
    packageId: row.package_id,
    label: row.label,
    displayName: display.displayName,
    type: row.revision_type,
    date,
    sortOrder: row.sort_order,
    number: display.number,
    attributes,
    issuedAt: row.issued_at.toISOString(),
    specCount,
    parentRevisionId: row.parent_revision_id,
    baseRevisionId: row.base_revision_id,
  };
}

async function profileForPackage(
  packageId: string,
  db: Queryable
): Promise<RevisionNomenclatureProfile | null> {
  const result = await db.query<PackageRow>(
    'SELECT project_id FROM design_packages WHERE id = $1',
    [packageId]
  );
  const row = result.rows[0];
  return row ? getRevisionNomenclatureForProject(row.project_id, db) : null;
}

async function getRevisionContext(
  revisionId: string,
  db: Queryable
): Promise<RevisionContextRow | null> {
  const result = await db.query<RevisionContextRow>(
    `SELECT pr.package_id, dp.name AS package_name, p.name AS project_name,
            p.description AS project_description
     FROM package_revisions pr
     JOIN design_packages dp ON dp.id = pr.package_id
     JOIN projects p ON p.id = dp.project_id
     WHERE pr.id = $1`,
    [revisionId]
  );
  return result.rows[0] ?? null;
}

async function insertRevisionRow(
  packageId: string,
  input: string | CreatePackageRevisionInput,
  profile: RevisionNomenclatureProfile,
  parentRevisionId: string | null,
  baseRevisionId: string | null,
  client: PoolClient
): Promise<RevisionRow> {
  const draft = createRevisionIdentityDraft(input, profile);
  const sortOrder = draft.sortOrder ?? (await nextSortOrder(packageId, client));
  const rev = await client.query<RevisionRow>(
    `INSERT INTO package_revisions
      (package_id, label, revision_type, revision_date, sort_order, attributes,
       parent_revision_id, base_revision_id)
     VALUES ($1, $2, $3, $4::date, $5, $6::jsonb, $7, $8)
     RETURNING id, package_id, label, revision_type, revision_date,
               sort_order, attributes, issued_at, parent_revision_id, base_revision_id`,
    [
      packageId,
      draft.label,
      draft.type,
      draft.date,
      sortOrder,
      JSON.stringify(draft.attributes),
      parentRevisionId,
      baseRevisionId,
    ]
  );
  const row = rev.rows[0];
  if (!row) throw new DatabaseError('createPackageRevision: no row returned after insert');
  return row;
}

/** Issue a revision: snapshot the package's full membership in one
 *  transaction. Duplicate label surfaces as a unique violation (→ 409). */
export async function createPackageRevision(
  packageId: string,
  input: string | CreatePackageRevisionInput,
  db: Pool = pool
): Promise<RevisionSummary> {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const locked = await lockPackage(packageId, client);
    const profile = await getRevisionNomenclatureForProject(locked.project_id, client);
    if (!profile) throw new DatabaseError('createPackageRevision: no nomenclature profile');
    const parentRevisionId = typeof input === 'string' ? null : (input.parentRevisionId ?? null);
    const baseRevisionId = typeof input === 'string' ? null : (input.baseRevisionId ?? null);
    await assertValidParentRevision(packageId, parentRevisionId, client);
    await assertValidBaseRevision(packageId, baseRevisionId, client);
    const row = await insertRevisionRow(
      packageId,
      input,
      profile,
      parentRevisionId,
      baseRevisionId,
      client
    );
    const entries = await snapshotMemberTrees(packageId, client);
    const { mode, overrideReadinessGate } = readinessInputFrom(input);
    assertReadyForFinal(entries, mode, overrideReadinessGate);
    await insertSnapshotRows(row.id, entries, client);
    await markMembersIssued(
      entries.map((e) => e.specId),
      client
    );
    await client.query('COMMIT');
    logger.info(
      { packageId, revisionId: row.id, label: row.label, specCount: entries.length },
      'createPackageRevision: revision issued'
    );
    return mapSummary(row, profile, entries.length);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`createPackageRevision: failed for package ${packageId}`, {
      cause: err,
    });
  } finally {
    client.release();
  }
}

/** Frozen trees in membership order, Zod-validated on read. Returns null
 *  when the revision does not exist (→ 404 at the API layer). */
export async function getPackageRevision(
  revisionId: string,
  db: Queryable = pool
): Promise<RevisionWithTrees | null> {
  try {
    const rev = await db.query<RevisionRow>(
      `SELECT id, package_id, label, revision_type, revision_date,
              sort_order, attributes, issued_at, parent_revision_id, base_revision_id
       FROM package_revisions WHERE id = $1`,
      [revisionId]
    );
    const row = rev.rows[0];
    if (!row) return null;
    const profile = await profileForPackage(row.package_id, db);
    const snaps = await db.query<SnapshotRow>(
      `SELECT spec_id, position, tree FROM package_revision_specs
       WHERE revision_id = $1 ORDER BY position`,
      [revisionId]
    );
    const specs = snaps.rows.map((snap) => ({
      specId: snap.spec_id,
      position: snap.position,
      tree: validateTree(snap.tree, snap.spec_id),
    }));
    return { ...mapSummary(row, profile, specs.length), specs };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getPackageRevision: query failed for ${revisionId}`, { cause: err });
  }
}

export async function getPackageRevisionManualData(
  revisionId: string,
  db: Queryable = pool
): Promise<RevisionManualData | null> {
  try {
    const context = await getRevisionContext(revisionId, db);
    if (context === null) return null;
    const revision = await getPackageRevision(revisionId, db);
    if (revision === null) return null;
    return {
      revision,
      project: { name: context.project_name, description: context.project_description },
      designPackage: { packageId: context.package_id, name: context.package_name },
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getPackageRevisionManualData: query failed for ${revisionId}`, {
      cause: err,
    });
  }
}

export async function getPackageRevisionAddendumManualData(
  revisionId: string,
  baseRevisionId: string,
  db: Queryable = pool
): Promise<RevisionAddendumManualData | null> {
  const target = await getPackageRevisionManualData(revisionId, db);
  const base = await getPackageRevisionManualData(baseRevisionId, db);
  if (target === null || base === null) return null;
  if (target.designPackage.packageId !== base.designPackage.packageId) {
    throw new RevisionComparisonError('addendum base revision belongs to a different package');
  }
  return {
    ...target,
    baseRevisionId,
    changedSpecs: changedRevisionSpecs(target.revision.specs, base.revision.specs),
  };
}
