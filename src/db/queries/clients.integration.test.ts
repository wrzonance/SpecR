import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  createClient,
  listClients,
  getClient,
  assertClientExists,
  ClientNotFoundError,
} from './clients.js';
import { createProject, softDeleteProject } from './projects.js';
import { updateProject } from './project-update.js';
import { findLibraryByName, DEFAULT_COMPANY_LIBRARY } from './libraries.js';
import { getPgCode } from '../../lib/pg-errors.js';

// Namespaces reserved by this file: clients and projects named 'client-it-%'.
// FK-safe cleanup: projects first (cascades project_sources; also releases the
// RESTRICT on clients.client_id), then clients.
afterEach(async () => {
  await pool.query(`DELETE FROM projects WHERE name LIKE 'client-it-%'`);
  await pool.query(`DELETE FROM clients WHERE name LIKE 'client-it-%'`);
});

async function companyLibraryId(): Promise<string> {
  const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
  if (!company) throw new Error('default company library missing — run seed');
  return company.id;
}

describe('clients query module (integration)', () => {
  it('createClient persists a row that getClient/listClients read back', async () => {
    const created = await createClient({ name: 'client-it-acme' });
    expect(created).toMatchObject({ name: 'client-it-acme', libraryId: null });

    const fetched = await getClient(created.id);
    expect(fetched).toMatchObject({ id: created.id, name: 'client-it-acme', projects: [] });

    const all = await listClients();
    expect(all.map((c) => c.name)).toContain('client-it-acme');
  });

  it('createClient links a client-tier library via library_id', async () => {
    const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
    const created = await createClient({ name: 'client-it-linked', libraryId: company!.id });
    expect(created.libraryId).toBe(company!.id);
  });

  it('a duplicate client name violates the UNIQUE constraint (pg 23505)', async () => {
    await createClient({ name: 'client-it-dup' });
    const err = await createClient({ name: 'client-it-dup' }).catch((e: unknown) => e);
    expect(getPgCode(err)).toBe('23505');
  });

  it('the firm section-number default is CHECK-constrained', async () => {
    const err = await pool
      .query(
        `INSERT INTO clients (name, section_number_format) VALUES ('client-it-bad-format', 'slashes')`
      )
      .catch((caught: unknown) => caught);
    expect((err as { code?: string }).code).toBe('23514');
  });

  it('getClient returns an associated project with its sources, clientId and clientName', async () => {
    const libId = await companyLibraryId();
    const client = await createClient({ name: 'client-it-owner' });
    const project = await createProject(
      { name: 'client-it-campus', sourceLibraryIds: [libId] },
      pool
    );
    await updateProject(project.projectId, { clientId: client.id }, pool);

    const detail = await getClient(client.id);
    expect(detail?.projects).toHaveLength(1);
    const p = detail?.projects[0];
    expect(p).toMatchObject({
      projectId: project.projectId,
      name: 'client-it-campus',
      clientId: client.id,
      clientName: 'client-it-owner',
    });
    expect(p?.sources).toEqual([
      expect.objectContaining({ libraryId: libId, tier: 'company', priority: 1 }),
    ]);
  });

  it('getClient excludes a soft-deleted project', async () => {
    const libId = await companyLibraryId();
    const client = await createClient({ name: 'client-it-sd' });
    const project = await createProject(
      { name: 'client-it-sd-campus', sourceLibraryIds: [libId] },
      pool
    );
    await updateProject(project.projectId, { clientId: client.id }, pool);
    await softDeleteProject(project.projectId, 'tester', pool);

    const detail = await getClient(client.id);
    expect(detail?.projects).toEqual([]);
  });

  it('assertClientExists throws ClientNotFoundError for an unknown id', async () => {
    await expect(
      assertClientExists('00000000-0000-0000-0000-000000000000', pool)
    ).rejects.toBeInstanceOf(ClientNotFoundError);
  });
});
