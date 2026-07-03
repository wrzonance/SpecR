import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import {
  handleGetRequiredSections,
  handleSetRequiredSections,
  handleGetPackageRequiredSections,
  handleSetPackageRequiredSections,
} from './required-sections-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
const createdProjectIds: string[] = [];
let projectId: string;
let packageId: string;

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

// A fresh project + one design package, tracked for cleanup. Seeding requires an empty
// target scope (a populated scope raises SeedConflict), so seed tests need their own.
async function makeProjectPkg(): Promise<{ projectId: string; packageId: string }> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('wave7c-req') RETURNING id`
  );
  const pid = p.rows[0]!.id;
  createdProjectIds.push(pid);
  const pkg = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, 'pkg', 1) RETURNING id`,
    [pid]
  );
  return { projectId: pid, packageId: pkg.rows[0]!.id };
}

beforeAll(async () => {
  ({ projectId, packageId } = await makeProjectPkg());
});

afterAll(async () => {
  // Cascades required_sections + design_packages.
  await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [createdProjectIds]);
});

describe('required-sections MCP tools', () => {
  it('set then get project required sections (explicit list)', async () => {
    const set = await handleSetRequiredSections({
      projectId,
      sections: [{ section: '27 21 00' }, { section: '27 41 00' }],
    });
    expect(isToolError(set)).toBe(false);
    const got = parse<{ section: string }[]>(await handleGetRequiredSections({ projectId }));
    expect(got.map((s) => s.section).sort((a, b) => a.localeCompare(b))).toEqual([
      '27 21 00',
      '27 41 00',
    ]);
  });

  it('set then get package required sections', async () => {
    const set = await handleSetPackageRequiredSections({
      projectId,
      packageId,
      sections: [{ section: '27 21 00' }],
    });
    expect(isToolError(set)).toBe(false);
    const got = parse<{ section: string }[]>(
      await handleGetPackageRequiredSections({ projectId, packageId })
    );
    expect(got.map((s) => s.section)).toEqual(['27 21 00']);
  });

  it('rejects both sections and seedFrom (mutual exclusion)', async () => {
    const res = await handleSetRequiredSections({
      projectId,
      sections: [{ section: '27 21 00' }],
      seedFrom: 'baseline',
    });
    expect(isToolError(res)).toBe(true);
  });

  it('rejects duplicate sections', async () => {
    const res = await handleSetRequiredSections({
      projectId,
      sections: [{ section: '27 21 00' }, { section: '27 21 00' }],
    });
    expect(isToolError(res)).toBe(true);
  });

  it('missing project and missing package are tool errors', async () => {
    expect(isToolError(await handleGetRequiredSections({ projectId: MISSING }))).toBe(true);
    expect(
      isToolError(await handleGetPackageRequiredSections({ projectId, packageId: MISSING }))
    ).toBe(true);
  });

  it('seeds an empty package from the project baseline (seedFrom)', async () => {
    const fresh = await makeProjectPkg();
    await handleSetRequiredSections({
      projectId: fresh.projectId,
      sections: [{ section: '27 21 00' }, { section: '27 41 00' }],
    });
    const seeded = await handleSetPackageRequiredSections({
      projectId: fresh.projectId,
      packageId: fresh.packageId,
      seedFrom: 'baseline',
    });
    expect(isToolError(seeded)).toBe(false);
    const got = parse<{ section: string }[]>(
      await handleGetPackageRequiredSections({
        projectId: fresh.projectId,
        packageId: fresh.packageId,
      })
    );
    expect(got.map((s) => s.section).sort((a, b) => a.localeCompare(b))).toEqual([
      '27 21 00',
      '27 41 00',
    ]);
  });

  it('seeds an empty package from another package by id (seedFrom.packageId)', async () => {
    const fresh = await makeProjectPkg();
    const pkgB = await pool.query<{ id: string }>(
      `INSERT INTO design_packages (project_id, name, position) VALUES ($1, 'pkgB', 2) RETURNING id`,
      [fresh.projectId]
    );
    const packageBId = pkgB.rows[0]!.id;
    await handleSetPackageRequiredSections({
      projectId: fresh.projectId,
      packageId: fresh.packageId,
      sections: [{ section: '27 21 00' }],
    });
    const seeded = await handleSetPackageRequiredSections({
      projectId: fresh.projectId,
      packageId: packageBId,
      seedFrom: { packageId: fresh.packageId },
    });
    expect(isToolError(seeded)).toBe(false);
    const got = parse<{ section: string }[]>(
      await handleGetPackageRequiredSections({ projectId: fresh.projectId, packageId: packageBId })
    );
    expect(got.map((s) => s.section)).toContain('27 21 00');
  });

  it('rejects seeding a baseline from a non-toc source (invalid direction)', async () => {
    const fresh = await makeProjectPkg();
    // baseline may only be seeded from 'toc'; a package source is an invalid direction.
    const res = await handleSetRequiredSections({
      projectId: fresh.projectId,
      seedFrom: { packageId: fresh.packageId },
    });
    expect(isToolError(res)).toBe(true);
  });

  it('rejects seeding a scope that already has sections (seed conflict)', async () => {
    const fresh = await makeProjectPkg();
    await handleSetPackageRequiredSections({
      projectId: fresh.projectId,
      packageId: fresh.packageId,
      sections: [{ section: '27 21 00' }],
    });
    const res = await handleSetPackageRequiredSections({
      projectId: fresh.projectId,
      packageId: fresh.packageId,
      seedFrom: 'baseline',
    });
    expect(isToolError(res)).toBe(true);
  });

  it('rejects a syntactically malformed UUID (schema validation, not not-found)', async () => {
    expect(isToolError(await handleGetRequiredSections({ projectId: 'not-a-uuid' }))).toBe(true);
    expect(
      isToolError(
        await handleGetPackageRequiredSections({ projectId: 'not-a-uuid', packageId: 'nope' })
      )
    ).toBe(true);
  });
});
