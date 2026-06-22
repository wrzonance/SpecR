import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';

interface Queryable {
  query: Pool['query'];
}

export interface RequiredSection {
  readonly id: string;
  readonly section: string;
  readonly title: string | null;
  readonly position: number;
}

export interface RequiredSectionInput {
  readonly section: string; // canonical — validated at the API boundary
  readonly title?: string;
}

export type RequiredScope =
  | { readonly kind: 'baseline'; readonly projectId: string }
  | { readonly kind: 'package'; readonly projectId: string; readonly packageId: string };

export type SeedSource =
  | { readonly from: 'baseline' }
  | { readonly from: 'toc' }
  | { readonly from: 'package'; readonly packageId: string };

export class RequiredSectionsProjectNotFoundError extends DatabaseError {}
export class RequiredSectionsPackageNotFoundError extends DatabaseError {}
export class RequiredSectionsSeedConflictError extends DatabaseError {}
export class RequiredSectionsInvalidSeedError extends DatabaseError {}

interface Row {
  readonly id: string;
  readonly section: string;
  readonly title: string | null;
  readonly position: number;
}

const SELECT_COLS = 'id, section, title, position';

function packageId(scope: RequiredScope): string | null {
  return scope.kind === 'package' ? scope.packageId : null;
}

async function assertScopeExists(scope: RequiredScope, db: Queryable): Promise<void> {
  const proj = await db.query(`SELECT 1 FROM projects WHERE id = $1`, [scope.projectId]);
  if ((proj.rowCount ?? 0) === 0) {
    throw new RequiredSectionsProjectNotFoundError(`project ${scope.projectId} not found`);
  }
  if (scope.kind === 'package') {
    const pkg = await db.query(`SELECT 1 FROM design_packages WHERE id = $1 AND project_id = $2`, [
      scope.packageId,
      scope.projectId,
    ]);
    if ((pkg.rowCount ?? 0) === 0) {
      throw new RequiredSectionsPackageNotFoundError(
        `package ${scope.packageId} not found in project ${scope.projectId}`
      );
    }
  }
}

async function readScope(scope: RequiredScope, db: Queryable): Promise<readonly RequiredSection[]> {
  const result = await db.query<Row>(
    `SELECT ${SELECT_COLS} FROM required_sections
     WHERE project_id = $1 AND package_id IS NOT DISTINCT FROM $2
     ORDER BY position`,
    [scope.projectId, packageId(scope)]
  );
  return result.rows;
}

export async function listRequiredSections(
  scope: RequiredScope,
  db: Queryable = pool
): Promise<readonly RequiredSection[]> {
  try {
    await assertScopeExists(scope, db);
    return await readScope(scope, db);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`listRequiredSections failed for project ${scope.projectId}`, {
      cause: err,
    });
  }
}

export async function setRequiredSections(
  scope: RequiredScope,
  entries: readonly RequiredSectionInput[],
  db: Pool = pool
): Promise<readonly RequiredSection[]> {
  let client: PoolClient | null = null;
  try {
    await assertScopeExists(scope, db);
    client = await db.connect();
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM required_sections WHERE project_id = $1 AND package_id IS NOT DISTINCT FROM $2`,
      [scope.projectId, packageId(scope)]
    );
    await client.query(
      `INSERT INTO required_sections (project_id, package_id, section, title, position)
       SELECT $1, $2, e.section, e.title, e.ord::int
       FROM jsonb_to_recordset($3::jsonb) AS e(section text, title text, ord int)`,
      [
        scope.projectId,
        packageId(scope),
        JSON.stringify(
          entries.map((e, i) => ({ section: e.section, title: e.title ?? null, ord: i + 1 }))
        ),
      ]
    );
    await client.query('COMMIT');
    return await readScope(scope, db);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`setRequiredSections failed for project ${scope.projectId}`, {
      cause: err,
    });
  } finally {
    if (client) client.release();
  }
}

function validateSeedForScope(scope: RequiredScope, seed: SeedSource): void {
  if (scope.kind === 'baseline' && seed.from !== 'toc') {
    throw new RequiredSectionsInvalidSeedError(
      `baseline can only be seeded from 'toc', not '${seed.from}'`
    );
  }
}

async function seedRows(scope: RequiredScope, seed: SeedSource, client: PoolClient): Promise<void> {
  const target = [scope.projectId, packageId(scope)];
  if (seed.from === 'toc') {
    await client.query(
      `INSERT INTO required_sections (project_id, package_id, section, title, position)
       SELECT $1, $2, s.section, s.title, ps.position
       FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
       WHERE ps.project_id = $1 AND s.section ~ '^\\d{2} \\d{2} \\d{2}(\\.\\d{2}( \\d{2})?)?$'
       ORDER BY ps.position`,
      target
    );
    return;
  }
  const sourcePackage = seed.from === 'baseline' ? null : seed.packageId;
  await client.query(
    `INSERT INTO required_sections (project_id, package_id, section, title, position)
     SELECT $1, $2, r.section, r.title, r.position
     FROM required_sections r
     WHERE r.project_id = $1 AND r.package_id IS NOT DISTINCT FROM $3
     ORDER BY r.position`,
    [scope.projectId, packageId(scope), sourcePackage]
  );
}

export async function seedRequiredSections(
  scope: RequiredScope,
  seed: SeedSource,
  db: Pool = pool
): Promise<readonly RequiredSection[]> {
  let client: PoolClient | null = null;
  try {
    validateSeedForScope(scope, seed);
    await assertScopeExists(scope, db);
    client = await db.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT 1 FROM required_sections WHERE project_id = $1 AND package_id IS NOT DISTINCT FROM $2 LIMIT 1`,
      [scope.projectId, packageId(scope)]
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw new RequiredSectionsSeedConflictError(
        `target scope already has required sections; replace explicitly`
      );
    }
    await seedRows(scope, seed, client);
    await client.query('COMMIT');
    return await readScope(scope, db);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`seedRequiredSections failed for project ${scope.projectId}`, {
      cause: err,
    });
  } finally {
    if (client) client.release();
  }
}
