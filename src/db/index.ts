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
