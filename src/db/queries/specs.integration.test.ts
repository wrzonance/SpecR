import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { createSpec } from './specs.js';

afterEach(async () => {
  await pool.query("DELETE FROM specs WHERE section = '99 00 00'");
});

describe('createSpec', () => {
  it('inserts a spec row and returns the UUID', async () => {
    const id = await createSpec({ section: '99 00 00', title: 'Test Spec', source: 'arcat' });
    expect(id).toMatch(/^[\da-f-]{36}$/);

    const result = await pool.query('SELECT id, section, title, source FROM specs WHERE id = $1', [
      id,
    ]);
    expect(result.rows[0]).toMatchObject({
      section: '99 00 00',
      title: 'Test Spec',
      source: 'arcat',
    });
  });

  it('createSpec with explicit pool client works', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = await createSpec({ section: '99 00 00', title: 'TX Test', source: 'cpi' }, client);
      expect(id).toMatch(/^[\da-f-]{36}$/);
      await client.query('ROLLBACK'); // rolled back, nothing inserted
    } finally {
      client.release();
    }
  });
});
