import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { handleCreateProject } from './create-project-handler.js';
import {
  handleGetProject,
  handleUpdateProject,
  handleDeleteProject,
  handleRestoreProject,
} from './project-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
let projectId: string;
const cleanup: string[] = [];

// Assert on the VALUE, not mere key presence, so the checks survive a handler that
// ever returns an explicit `isError: false` on success.
function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}

async function seedLibraryId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE tier IN ('company','client') LIMIT 1`
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no company/client library seeded — run pnpm seed');
  return id;
}

beforeAll(async () => {
  const libId = await seedLibraryId();
  const res = await handleCreateProject({ name: `wave2-${Date.now()}`, sourceLibraryIds: [libId] });
  if (isToolError(res)) throw new Error(`seed project creation failed: ${res.content[0]?.text}`);
  projectId = (JSON.parse(res.content[0]!.text) as { projectId: string }).projectId;
  cleanup.push(projectId);
});

afterAll(async () => {
  for (const id of cleanup) await pool.query('DELETE FROM projects WHERE id = $1', [id]);
});

describe('project lifecycle MCP tools', () => {
  it('get_project returns the project by id', async () => {
    const res = await handleGetProject({ projectId });
    expect(isToolError(res)).toBe(false);
    expect((JSON.parse(res.content[0]!.text) as { projectId: string }).projectId).toBe(projectId);
  });

  it('update_project renames the project', async () => {
    const res = await handleUpdateProject({ projectId, name: 'Renamed Wave2' });
    expect(isToolError(res)).toBe(false);
    const data = JSON.parse(res.content[0]!.text) as { projectId: string; name: string };
    expect(data.projectId).toBe(projectId); // keyed projectId, consistent with the other tools + REST
    expect(data.name).toBe('Renamed Wave2');
  });

  it('update_project rejects an empty patch (no fields to change)', async () => {
    const res = await handleUpdateProject({ projectId });
    expect(isToolError(res)).toBe(true);
  });

  it('delete_project soft-deletes and restore_project brings it back', async () => {
    const del = await handleDeleteProject({ projectId, deletedBy: 'wave2-test' });
    expect(isToolError(del)).toBe(false);
    expect((JSON.parse(del.content[0]!.text) as { deletedBy: string }).deletedBy).toBe(
      'wave2-test'
    );

    const restored = await handleRestoreProject({ projectId });
    expect(isToolError(restored)).toBe(false);
  });

  it('get_project returns a tool error for a missing project', async () => {
    const res = await handleGetProject({ projectId: MISSING });
    expect(isToolError(res)).toBe(true);
  });

  it('tools return a tool error (never throw) on invalid input', async () => {
    const res = await handleDeleteProject({ projectId: 'not-a-uuid', deletedBy: '' });
    expect(isToolError(res)).toBe(true);
  });
});
