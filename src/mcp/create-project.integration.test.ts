import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { handleCreateProject } from './create-project-handler.js';
import { handleListLibraries } from './handlers.js';

const created: string[] = [];
afterAll(async () => {
  for (const id of created) await pool.query('DELETE FROM projects WHERE id = $1', [id]);
});

async function seedLibraryId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE tier IN ('company','client') LIMIT 1`
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no company/client library seeded — run pnpm seed');
  return id;
}

describe('create_project MCP tool', () => {
  it('creates a project and returns its id', async () => {
    const libId = await seedLibraryId();
    const res = await handleCreateProject({
      name: `mcp-contract-${Date.now()}`,
      sourceLibraryIds: [libId],
    });
    expect('isError' in res).toBe(false);
    // createProject returns a ProjectSummary keyed `projectId` (mirrors REST POST /projects).
    const data = JSON.parse(res.content[0]!.text) as { projectId: string };
    expect(data.projectId).toMatch(/^[0-9a-f-]{36}$/);
    created.push(data.projectId);
  });

  it('returns a tool error (never throws) on invalid input', async () => {
    const res = await handleCreateProject({ name: '', sourceLibraryIds: [] });
    expect('isError' in res && res.isError).toBe(true);
  });

  it('list_libraries surfaces the library IDs create_project needs (MCP-only discoverability)', async () => {
    const res = await handleListLibraries();
    expect('isError' in res).toBe(false);
    const libs = JSON.parse(res.content[0]!.text) as { id: string; tier: string }[];
    const usable = libs.find((l) => l.tier === 'company' || l.tier === 'client');
    expect(usable?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
