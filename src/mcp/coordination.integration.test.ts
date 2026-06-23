import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { handleCoordinationReport } from './handlers.js';

const suffix = randomUUID().slice(0, 8);
let projectId: string;

beforeAll(async () => {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`coord-mcp-${suffix}`]
  );
  projectId = p.rows[0]!.id;
});
afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('handleCoordinationReport (MCP)', () => {
  it('returns a JSON text report for a known project', async () => {
    const res = await handleCoordinationReport({ projectId });
    expect('isError' in res).toBe(false);
    const text = res.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { projectId: string; summary: { total: number } };
    expect(parsed.projectId).toBe(projectId);
    expect(parsed.summary.total).toBe(0);
  });

  it('returns isError (never throws) for an unknown project', async () => {
    const res = await handleCoordinationReport({
      projectId: '00000000-0000-4000-8000-000000000000',
    });
    expect('isError' in res && res.isError).toBe(true);
  });
});
