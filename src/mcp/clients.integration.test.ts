import { describe, it, expect, afterAll } from 'vitest';
import { pool, createProject, findLibraryByName, DEFAULT_COMPANY_LIBRARY } from '../db/index.js';
import {
  handleListClients,
  handleGetClient,
  handleCreateClient,
  handleUpdateClient,
} from './clients-handlers.js';
import { handleUpdateProject } from './project-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-4000-8000-000000000099';

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

let seq = 0;
const uniq = (part: string): string => {
  seq += 1;
  return `clients-mcp-test-${part}-${seq}`;
};

// FK-safe: projects first (cascades sources, releases the RESTRICT), then clients.
afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE name LIKE 'clients-mcp-test-%'`);
  await pool.query(`DELETE FROM clients WHERE name LIKE 'clients-mcp-test-%'`);
});

async function companyLibId(): Promise<string> {
  const lib = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
  if (!lib) throw new Error('default company library missing — run migrations');
  return lib.id;
}

describe('clients MCP tools', () => {
  it('create_client returns the new client summary', async () => {
    const res = await handleCreateClient({ name: uniq('create'), sectionNumberFormat: 'dots' });
    expect(isToolError(res)).toBe(false);
    const client = parse<{
      id: string;
      name: string;
      libraryId: string | null;
      sectionNumberFormat: string;
    }>(res);
    expect(client.name).toContain('clients-mcp-test-create');
    expect(client.libraryId).toBeNull();
    expect(client.sectionNumberFormat).toBe('dots');
  });

  it('update_client changes the firm section-number default', async () => {
    const created = parse<{ id: string }>(await handleCreateClient({ name: uniq('format') }));
    const result = await handleUpdateClient({
      clientId: created.id,
      sectionNumberFormat: 'compact',
    });
    expect(isToolError(result)).toBe(false);
    expect(parse<{ sectionNumberFormat: string }>(result).sectionNumberFormat).toBe('compact');
    expect(
      isToolError(await handleUpdateClient({ clientId: MISSING, sectionNumberFormat: 'dots' }))
    ).toBe(true);
  });

  it('create_client rejects a blank name and a duplicate name', async () => {
    expect(isToolError(await handleCreateClient({ name: '' }))).toBe(true);
    const name = uniq('dup');
    await handleCreateClient({ name });
    expect(isToolError(await handleCreateClient({ name }))).toBe(true);
  });

  it('create_client rejects an unknown libraryId', async () => {
    const res = await handleCreateClient({ name: uniq('badlib'), libraryId: MISSING });
    expect(isToolError(res)).toBe(true);
  });

  it('list_clients includes a created client', async () => {
    const name = uniq('list');
    await handleCreateClient({ name });
    const rows = parse<{ name: string }[]>(await handleListClients());
    expect(rows.map((c) => c.name)).toContain(name);
  });

  it('get_client returns the client with its projects; bad/unknown id is an error', async () => {
    const created = parse<{ id: string }>(await handleCreateClient({ name: uniq('owner') }));
    const libId = await companyLibId();
    const project = await createProject({ name: uniq('campus'), sourceLibraryIds: [libId] }, pool);
    await handleUpdateProject({ projectId: project.projectId, clientId: created.id });

    const detail = parse<{ id: string; projects: { projectId: string; clientId: string }[] }>(
      await handleGetClient({ clientId: created.id })
    );
    expect(detail.projects.map((p) => p.projectId)).toContain(project.projectId);
    expect(detail.projects[0]?.clientId).toBe(created.id);

    expect(isToolError(await handleGetClient({ clientId: 'nope' }))).toBe(true);
    expect(isToolError(await handleGetClient({ clientId: MISSING }))).toBe(true);
  });

  it('update_project associates + echoes clientId and errors on an unknown client', async () => {
    const client = parse<{ id: string }>(await handleCreateClient({ name: uniq('assoc') }));
    const libId = await companyLibId();
    const project = await createProject(
      { name: uniq('assoc-proj'), sourceLibraryIds: [libId] },
      pool
    );

    const res = await handleUpdateProject({ projectId: project.projectId, clientId: client.id });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ clientId: string }>(res).clientId).toBe(client.id);

    const bad = await handleUpdateProject({ projectId: project.projectId, clientId: MISSING });
    expect(isToolError(bad)).toBe(true);
  });
});
