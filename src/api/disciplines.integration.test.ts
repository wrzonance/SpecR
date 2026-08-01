import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary, createSpec } from '../db/index.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

// FK-safe cleanup, all namespaced to reserved 'disc-api-%' prefixes.
afterEach(async () => {
  await pool.query(
    `DELETE FROM discipline_section_rules WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'disc-api-%')`
  );
  await pool.query(
    `DELETE FROM project_specs WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'disc-api-%')`
  );
  await pool.query(
    `DELETE FROM specs WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'disc-api-%')`
  );
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'disc-api-%')`
  );
  await pool.query(`DELETE FROM projects WHERE name LIKE 'disc-api-%'`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'disc-api-%'`);
});

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}
async function put(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function del(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' });
}

interface DisciplineRow {
  readonly key: string;
  readonly rules: readonly { divisionStart: string; divisionEnd: string }[];
}
interface SpecRow {
  readonly section: string;
  readonly discipline: string | null;
}

async function seedLibraryWithSpecs(): Promise<string> {
  const lib = await createLibrary({ tier: 'client', name: `disc-api-${randomUUID()}` });
  await createSpec({
    section: '26 05 19',
    title: 'Electrical',
    source: 'arcat',
    libraryId: lib.id,
  });
  await createSpec({ section: '23 07 00', title: 'HVAC', source: 'arcat', libraryId: lib.id });
  // Division 24 is reserved in MasterFormat, so it maps to no discipline (null).
  await createSpec({ section: '24 05 00', title: 'Reserved', source: 'arcat', libraryId: lib.id });
  return lib.id;
}

describe('GET /disciplines', () => {
  it('200 — built-in default catalog maps the seeded CSI divisions', async () => {
    const res = await get('/disciplines');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: DisciplineRow[]; meta: { inherited: boolean } };
    expect(body.meta.inherited).toBe(true);
    const electrical = body.data.find((d) => d.key === 'electrical');
    expect(electrical?.rules).toEqual([{ divisionStart: '26', divisionEnd: '26' }]);
  });

  it('400 — a malformed libraryId is rejected', async () => {
    const res = await get('/disciplines?libraryId=not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('400 — a repeated (non-scalar) libraryId is rejected, not silently ignored', async () => {
    const res = await get(`/disciplines?libraryId=${randomUUID()}&libraryId=${randomUUID()}`);
    expect(res.status).toBe(400);
  });

  it('404 — an unknown libraryId', async () => {
    const res = await get(`/disciplines?libraryId=${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /libraries/{id}/specs — discipline field + filter', () => {
  it('200 — every row carries its resolved discipline', async () => {
    const libId = await seedLibraryWithSpecs();
    const res = await get(`/libraries/${libId}/specs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: SpecRow[] };
    const bySection = new Map(body.data.map((s) => [s.section, s.discipline]));
    expect(bySection.get('26 05 19')).toBe('electrical');
    expect(bySection.get('23 07 00')).toBe('hvac');
    expect(bySection.get('24 05 00')).toBeNull();
  });

  it('200 — ?discipline= keeps only matching specs', async () => {
    const libId = await seedLibraryWithSpecs();
    const res = await get(`/libraries/${libId}/specs?discipline=electrical`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: SpecRow[] };
    expect(body.data.map((s) => s.section)).toEqual(['26 05 19']);
  });

  it('libraries: blank discipline filter returns all specs, not none', async () => {
    const libId = await seedLibraryWithSpecs();
    const unfiltered = (await (await get(`/libraries/${libId}/specs`)).json()) as {
      data: SpecRow[];
    };
    const expected = unfiltered.data.map((s) => s.section);
    expect(expected).toHaveLength(3);

    // `?discipline=` and a whitespace-only value both mean "no filter", not "match the
    // empty discipline key" — the latter silently returns [] from a populated library (#548).
    for (const raw of ['', '%20%20%20']) {
      const res = await get(`/libraries/${libId}/specs?discipline=${raw}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: SpecRow[] };
      expect(body.data.map((s) => s.section)).toEqual(expected);
    }
  });

  it('400 — a repeated (non-scalar) discipline filter is rejected, not silently ignored', async () => {
    const libId = await seedLibraryWithSpecs();
    const res = await get(`/libraries/${libId}/specs?discipline=electrical&discipline=hvac`);
    expect(res.status).toBe(400);
  });
});

describe('PUT/DELETE /libraries/{id}/disciplines — per-library override', () => {
  it('override remaps a division and leaves other libraries on the default', async () => {
    const libId = await seedLibraryWithSpecs();
    const otherId = await seedLibraryWithSpecs();
    const put1 = await put(`/libraries/${libId}/disciplines`, {
      rules: [{ discipline: 'mechanical', divisionStart: '21', divisionEnd: '23' }],
    });
    expect(put1.status).toBe(200);

    // The override library maps HVAC (23) to Mechanical now.
    const overridden = (await (await get(`/libraries/${libId}/specs`)).json()) as {
      data: SpecRow[];
    };
    expect(overridden.data.find((s) => s.section === '23 07 00')?.discipline).toBe('mechanical');
    // A total override means the built-in electrical rule no longer applies here.
    expect(overridden.data.find((s) => s.section === '26 05 19')?.discipline).toBeNull();

    // The untouched library still resolves against the default.
    const untouched = (await (await get(`/libraries/${otherId}/specs`)).json()) as {
      data: SpecRow[];
    };
    expect(untouched.data.find((s) => s.section === '23 07 00')?.discipline).toBe('hvac');

    // Clearing reverts to the default; a second clear is a no-op.
    const del1 = await del(`/libraries/${libId}/disciplines`);
    expect(del1.status).toBe(200);
    expect(((await del1.json()) as { data: { cleared: boolean } }).data.cleared).toBe(true);
    // A `cleared: true` flag alone can't prove the override is gone — re-list and confirm the
    // built-in mapping actually resolves again (23→hvac, 26→electrical) after the clear.
    const reverted = (await (await get(`/libraries/${libId}/specs`)).json()) as {
      data: SpecRow[];
    };
    expect(reverted.data.find((s) => s.section === '23 07 00')?.discipline).toBe('hvac');
    expect(reverted.data.find((s) => s.section === '26 05 19')?.discipline).toBe('electrical');
    const del2 = await del(`/libraries/${libId}/disciplines`);
    expect(((await del2.json()) as { data: { cleared: boolean } }).data.cleared).toBe(false);
  });

  it('422 — an unknown discipline key', async () => {
    const libId = await seedLibraryWithSpecs();
    const res = await put(`/libraries/${libId}/disciplines`, {
      rules: [{ discipline: 'not-a-discipline', divisionStart: '26', divisionEnd: '26' }],
    });
    expect(res.status).toBe(422);
  });

  it('400 — overlapping division ranges', async () => {
    const libId = await seedLibraryWithSpecs();
    const res = await put(`/libraries/${libId}/disciplines`, {
      rules: [
        { discipline: 'electrical', divisionStart: '26', divisionEnd: '27' },
        { discipline: 'communications', divisionStart: '27', divisionEnd: '28' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('400 — an empty rule set', async () => {
    const libId = await seedLibraryWithSpecs();
    const res = await put(`/libraries/${libId}/disciplines`, { rules: [] });
    expect(res.status).toBe(400);
  });

  it('404 — an unknown library', async () => {
    const res = await put(`/libraries/${randomUUID()}/disciplines`, {
      rules: [{ discipline: 'electrical', divisionStart: '26', divisionEnd: '26' }],
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/{id}/specs — discipline field + filter', () => {
  async function seedProjectWithSpecs(): Promise<string> {
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
      [`disc-api-${randomUUID()}`]
    );
    const projectId = project.rows[0]!.id;
    const specs: readonly [string, string][] = [
      ['26 05 19', 'Electrical'],
      ['23 07 00', 'HVAC'],
    ];
    let position = 1;
    for (const [section, title] of specs) {
      const spec = await pool.query<{ id: string }>(
        `INSERT INTO specs (section, title, source, project_id) VALUES ($1, $2, 'arcat', $3) RETURNING id`,
        [section, title, projectId]
      );
      await pool.query(
        `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
        [projectId, spec.rows[0]!.id, position++]
      );
    }
    return projectId;
  }

  it('200 — rows carry the built-in default discipline; filter narrows the listing', async () => {
    const projectId = await seedProjectWithSpecs();
    const all = (await (await get(`/projects/${projectId}/specs`)).json()) as { data: SpecRow[] };
    const bySection = new Map(all.data.map((s) => [s.section, s.discipline]));
    expect(bySection.get('26 05 19')).toBe('electrical');
    expect(bySection.get('23 07 00')).toBe('hvac');

    const hvac = (await (await get(`/projects/${projectId}/specs?discipline=hvac`)).json()) as {
      data: SpecRow[];
    };
    expect(hvac.data.map((s) => s.section)).toEqual(['23 07 00']);
  });

  it('404 — an unknown project', async () => {
    const res = await get(`/projects/${randomUUID()}/specs`);
    expect(res.status).toBe(404);
  });

  it('projects: blank discipline filter returns all specs, not none', async () => {
    const projectId = await seedProjectWithSpecs();
    const unfiltered = (await (await get(`/projects/${projectId}/specs`)).json()) as {
      data: SpecRow[];
    };
    const expected = unfiltered.data.map((s) => s.section);
    expect(expected).toHaveLength(2);

    for (const raw of ['', '%20%20%20']) {
      const res = await get(`/projects/${projectId}/specs?discipline=${raw}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: SpecRow[] };
      expect(body.data.map((s) => s.section)).toEqual(expected);
    }
  });

  it('400 — a repeated (non-scalar) discipline filter is rejected, not silently ignored', async () => {
    const projectId = await seedProjectWithSpecs();
    const res = await get(`/projects/${projectId}/specs?discipline=hvac&discipline=electrical`);
    expect(res.status).toBe(400);
  });
});
