import { Pool } from 'pg';
import { config } from '../lib/env.js';
import { SpecrError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export class DatabaseError extends SpecrError {}

export function createPool(): Pool {
  return new Pool({ connectionString: config.DATABASE_URL });
}

export async function pingDatabase(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new DatabaseError('database ping failed', { cause: err });
  }
}

export const pool = createPool();

pool.on('error', (err: Error) => {
  logger.error({ err }, 'pg pool error');
});

export { findSpecById, updateSpec, createSpec } from './queries/specs.js';
export type { SpecSummary, UpdateSpecInput, CreateSpecInput } from './queries/specs.js';
export { insertTree } from './queries/paragraphs.js';
export { insertRefs } from './queries/refs.js';
export {
  createProject,
  findProjectById,
  addSpecToProject,
  removeSpecFromProject,
  getBrokenRefs,
} from './queries/projects.js';
export type {
  ProjectSummary,
  ProjectWithToc,
  ProjectTocEntry,
  BrokenRef,
  CreateProjectInput,
  AddSpecResult,
} from './queries/projects.js';
