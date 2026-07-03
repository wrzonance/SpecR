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
let projectId: string;
let packageId: string;

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

beforeAll(async () => {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('wave7c-req') RETURNING id`
  );
  projectId = p.rows[0]!.id;
  const pkg = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, 'pkg', 1) RETURNING id`,
    [projectId]
  );
  packageId = pkg.rows[0]!.id;
});

afterAll(async () => {
  // Cascades required_sections + design_packages.
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
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
});
