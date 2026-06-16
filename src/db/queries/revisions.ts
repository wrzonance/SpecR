import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { logger } from '../../lib/logger.js';
import { SpecTreeSchema } from '../../ast/index.js';
import type { SpecTree } from '../../ast/index.js';
import { buildNodeTree } from './specs.js';
import type { ParagraphTreeRow } from './specs.js';
import { PackageNotFoundError } from './packages.js';

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

/** A snapshot tree failed SpecTreeSchema validation. At write → 422 (the
 *  package content cannot be issued); at read → 500 (integrity failure). */
export class SnapshotValidationError extends DatabaseError {}

export interface RevisionSummary {
  readonly revisionId: string;
  readonly packageId: string;
  readonly label: string;
  readonly issuedAt: string;
  readonly specCount: number;
}

export interface RevisionSpecEntry {
  readonly specId: string;
  readonly position: number;
  readonly tree: SpecTree;
}

export interface RevisionWithTrees {
  readonly revisionId: string;
  readonly packageId: string;
  readonly label: string;
  readonly issuedAt: string;
  readonly specs: readonly RevisionSpecEntry[];
}

interface RevisionRow {
  readonly id: string;
  readonly package_id: string;
  readonly label: string;
  readonly issued_at: Date;
}

interface MemberRow {
  readonly spec_id: string;
  readonly section: string | null;
  readonly title: string | null;
  readonly position: number;
}

interface SnapshotRow {
  readonly spec_id: string;
  readonly position: number;
  readonly tree: unknown;
}

function validateTree(candidate: unknown, specId: string): SpecTree {
  const parsed = SpecTreeSchema.safeParse(candidate);
  if (!parsed.success) {
    // User-facing via the 422 surface at write — no function-name prefix.
    throw new SnapshotValidationError(
      `snapshot tree for spec ${specId} failed SpecTree validation`,
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

async function lockPackage(packageId: string, client: PoolClient): Promise<void> {
  const res = await client.query('SELECT 1 FROM design_packages WHERE id = $1 FOR UPDATE', [
    packageId,
  ]);
  if (res.rowCount === 0) {
    throw new PackageNotFoundError(`createPackageRevision: package ${packageId} not found`);
  }
}

/** Freeze every member section's tree, in membership order. */
async function snapshotMemberTrees(
  packageId: string,
  client: PoolClient
): Promise<readonly RevisionSpecEntry[]> {
  const members = await client.query<MemberRow>(
    `SELECT ps.spec_id, ps.position, s.section, s.title
     FROM package_specs ps JOIN specs s ON s.id = ps.spec_id
     WHERE ps.package_id = $1 ORDER BY ps.position`,
    [packageId]
  );
  const entries: RevisionSpecEntry[] = [];
  for (const member of members.rows) {
    const paras = await client.query<ParagraphTreeRow>(
      `SELECT id, parent_id, node_type, text, position, vanish, conflicts, source_facts
       FROM paragraphs WHERE spec_id = $1`,
      [member.spec_id]
    );
    const candidate = {
      id: member.spec_id,
      section: member.section ?? '',
      title: member.title ?? '',
      parts: buildNodeTree(paras.rows),
    };
    entries.push({
      specId: member.spec_id,
      position: member.position,
      tree: validateTree(candidate, member.spec_id),
    });
  }
  return entries;
}

async function insertSnapshotRows(
  revisionId: string,
  entries: readonly RevisionSpecEntry[],
  client: PoolClient
): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO package_revision_specs (revision_id, spec_id, position, tree)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [revisionId, entry.specId, entry.position, JSON.stringify(entry.tree)]
    );
  }
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

/** Issue a revision: snapshot the package's full membership in one
 *  transaction. Duplicate label surfaces as a unique violation (→ 409). */
export async function createPackageRevision(
  packageId: string,
  label: string,
  db: Pool = pool
): Promise<RevisionSummary> {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await lockPackage(packageId, client);
    const rev = await client.query<RevisionRow>(
      `INSERT INTO package_revisions (package_id, label)
       VALUES ($1, $2) RETURNING id, package_id, label, issued_at`,
      [packageId, label]
    );
    const row = rev.rows[0];
    if (!row) throw new DatabaseError('createPackageRevision: no row returned after insert');
    const entries = await snapshotMemberTrees(packageId, client);
    await insertSnapshotRows(row.id, entries, client);
    await markMembersIssued(
      entries.map((e) => e.specId),
      client
    );
    await client.query('COMMIT');
    logger.info(
      { packageId, revisionId: row.id, label, specCount: entries.length },
      'createPackageRevision: revision issued'
    );
    return {
      revisionId: row.id,
      packageId: row.package_id,
      label: row.label,
      issuedAt: row.issued_at.toISOString(),
      specCount: entries.length,
    };
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
      'SELECT id, package_id, label, issued_at FROM package_revisions WHERE id = $1',
      [revisionId]
    );
    const row = rev.rows[0];
    if (!row) return null;
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
    return {
      revisionId: row.id,
      packageId: row.package_id,
      label: row.label,
      issuedAt: row.issued_at.toISOString(),
      specs,
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getPackageRevision: query failed for ${revisionId}`, { cause: err });
  }
}
