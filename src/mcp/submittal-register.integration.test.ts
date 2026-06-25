import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../db/index.js';
import { handleSubmittalRegister } from './handlers.js';

const suffix = randomUUID().slice(0, 8);
let projectId: string;

beforeAll(async () => {
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`submittal-mcp-${suffix}`]
  );
  const id = project.rows[0]?.id;
  if (id === undefined) throw new Error('project insert returned no id');
  projectId = id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('handleSubmittalRegister (MCP)', () => {
  it('returns a JSON text register for a known project', async () => {
    const result = await handleSubmittalRegister({ projectId, specIds: [] });

    expect('isError' in result).toBe(false);
    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { projectId: string; rows: unknown[] };
    expect(parsed.projectId).toBe(projectId);
    expect(parsed.rows).toEqual([]);
  });

  it('returns isError for an unknown project instead of throwing', async () => {
    const result = await handleSubmittalRegister({
      projectId: '00000000-0000-4000-8000-000000000000',
      specIds: [],
    });

    expect('isError' in result && result.isError).toBe(true);
  });
});
