import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import type { SpecTree } from '../../ast/index.js';
import { buildSubmittalRegister, type SubmittalRegister } from '../../submittals/index.js';
import { getSpecTree } from './specs.js';

interface Queryable {
  query: Pool['query'];
}

export class SubmittalRegisterProjectNotFoundError extends DatabaseError {}
export class SubmittalRegisterSpecNotInProjectError extends DatabaseError {}

export interface ProjectSubmittalRegister extends SubmittalRegister {
  readonly projectId: string;
  readonly specIds: readonly string[];
}

async function assertProject(projectId: string, client: Queryable): Promise<void> {
  const result = await client.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if ((result.rowCount ?? 0) === 0) {
    throw new SubmittalRegisterProjectNotFoundError(`project ${projectId} not found`);
  }
}

async function readSelectedSpecIds(
  projectId: string,
  specIds: readonly string[],
  client: Queryable
): Promise<readonly string[]> {
  if (specIds.length === 0) return [];
  const result = await client.query<{ id: string }>(
    `SELECT ps.spec_id AS id
     FROM project_specs ps
     WHERE ps.project_id = $1 AND ps.spec_id = ANY($2::uuid[])
     ORDER BY array_position($2::uuid[], ps.spec_id)`,
    [projectId, specIds]
  );
  if (result.rows.length !== specIds.length) {
    throw new SubmittalRegisterSpecNotInProjectError(
      'one or more selected specs are not in project'
    );
  }
  return result.rows.map((row) => row.id);
}

async function readScope(
  projectId: string,
  specIds: readonly string[],
  db: Pool
): Promise<readonly string[]> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await assertProject(projectId, client);
    const selected = await readSelectedSpecIds(projectId, specIds, client);
    await client.query('COMMIT');
    return selected;
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function readTrees(specIds: readonly string[]): Promise<readonly SpecTree[]> {
  const trees: SpecTree[] = [];
  for (const specId of specIds) {
    const result = await getSpecTree(specId);
    if (result === null) {
      throw new SubmittalRegisterSpecNotInProjectError(`spec ${specId} not in project`);
    }
    trees.push(result.tree);
  }
  return trees;
}

export async function getSubmittalRegister(
  projectId: string,
  specIds: readonly string[],
  db: Pool = pool
): Promise<ProjectSubmittalRegister> {
  try {
    const selected = await readScope(projectId, specIds, db);
    const trees = await readTrees(selected);
    const register = buildSubmittalRegister(trees);
    return { projectId, specIds: selected, ...register };
  } catch (err) {
    if (
      err instanceof SubmittalRegisterProjectNotFoundError ||
      err instanceof SubmittalRegisterSpecNotInProjectError ||
      err instanceof DatabaseError
    ) {
      throw err;
    }
    throw new DatabaseError(`getSubmittalRegister failed for project ${projectId}`, {
      cause: err,
    });
  }
}
