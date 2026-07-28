import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import type { SpecTree } from '../../ast/index.js';
import type { HighlightReviewFinding } from '../../lib/highlight-review.js';
import {
  evaluateSpecReadiness,
  summarizeReadinessFindings,
  type ReadinessFinding,
  type ReadinessSummary,
} from '../../lib/readiness-review.js';
import { getSpecTree } from './specs.js';
import { SpecNotFoundError } from './edit-gate.js';
import { PackageNotFoundError } from './packages.js';
import { snapshotMemberTrees } from './revision-snapshot.js';

interface Queryable {
  query: Pool['query'];
}

// Dry-run counterpart to `assertReadyForFinal` (ADR-079): a specifier can see
// exactly what the gate would block on, scoped to a single spec or every
// member of a design package.
export type ReadinessScope =
  | { readonly kind: 'spec'; readonly specId: string }
  | { readonly kind: 'package'; readonly packageId: string };

export type StampedReadinessFinding = ReadinessFinding & {
  readonly specId: string;
  readonly specSection: string;
};

export interface StampedHighlightAdvisory {
  readonly specId: string;
  readonly specSection: string;
  readonly finding: HighlightReviewFinding;
}

export interface ReadinessReport {
  readonly scope: ReadinessScope;
  readonly findings: readonly StampedReadinessFinding[];
  /** Advisory-only (ADR-079 decision 3) — never factors into readyForFinal. */
  readonly highlightAdvisory: readonly StampedHighlightAdvisory[];
  readonly summary: ReadinessSummary;
  /** findings.length === 0 — a computed convenience, never a second source
   *  of truth (ADR-079 decision 16); the highlight advisory never gates it. */
  readonly readyForFinal: boolean;
}

interface ReadinessMember {
  readonly specId: string;
  readonly tree: SpecTree;
}

function stampMember(member: ReadinessMember): {
  readonly findings: readonly StampedReadinessFinding[];
  readonly highlightAdvisory: readonly StampedHighlightAdvisory[];
} {
  const { findings, highlightAdvisory } = evaluateSpecReadiness(member.tree);
  const specSection = member.tree.section;
  return {
    findings: findings.map((finding) => ({ ...finding, specId: member.specId, specSection })),
    highlightAdvisory: highlightAdvisory.findings.map((finding) => ({
      specId: member.specId,
      specSection,
      finding,
    })),
  };
}

function buildReport(scope: ReadinessScope, members: readonly ReadinessMember[]): ReadinessReport {
  const findings: StampedReadinessFinding[] = [];
  const highlightAdvisory: StampedHighlightAdvisory[] = [];
  for (const member of members) {
    const stamped = stampMember(member);
    findings.push(...stamped.findings);
    highlightAdvisory.push(...stamped.highlightAdvisory);
  }
  return {
    scope,
    findings,
    highlightAdvisory,
    summary: summarizeReadinessFindings(findings),
    readyForFinal: findings.length === 0,
  };
}

async function readSpecMember(specId: string, db: Pool): Promise<readonly ReadinessMember[]> {
  const result = await getSpecTree(specId, db);
  if (result === null) throw new SpecNotFoundError(`spec ${specId} not found`);
  return [{ specId, tree: result.tree }];
}

async function assertPackageExists(packageId: string, client: Queryable): Promise<void> {
  const result = await client.query(`SELECT 1 FROM design_packages WHERE id = $1`, [packageId]);
  if ((result.rowCount ?? 0) === 0) {
    throw new PackageNotFoundError(`package ${packageId} not found`);
  }
}

/** Package scope reuses `snapshotMemberTrees` (#392) read-only — zero edits
 *  to that file — inside its own REPEATABLE READ / READ ONLY transaction, so
 *  every member's tree comes from one consistent point-in-time view. Any
 *  failure rolls back best-effort before the error propagates (INV-14). */
async function readPackageMembers(
  packageId: string,
  db: Pool
): Promise<readonly ReadinessMember[]> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await assertPackageExists(packageId, client);
    const entries = await snapshotMemberTrees(packageId, client);
    await client.query('COMMIT');
    return entries.map((entry) => ({ specId: entry.specId, tree: entry.tree }));
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function readMembers(scope: ReadinessScope, db: Pool): Promise<readonly ReadinessMember[]> {
  return scope.kind === 'spec'
    ? readSpecMember(scope.specId, db)
    : readPackageMembers(scope.packageId, db);
}

/**
 * Dry-run view of the issuance-readiness gate (ADR-079): every
 * `ReadinessFinding` across the scope's member spec(s), stamped with which
 * spec produced it, alongside the advisory-only highlight report. A clean
 * spec or package (`readyForFinal: true`) is exactly the set the gate would
 * let through in `mode: 'final'`.
 */
export async function getReadinessReport(
  scope: ReadinessScope,
  db: Pool = pool
): Promise<ReadinessReport> {
  try {
    const members = await readMembers(scope, db);
    return buildReport(scope, members);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('getReadinessReport failed', { cause: err });
  }
}
