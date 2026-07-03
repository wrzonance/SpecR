import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import {
  handleListRevisionNomenclatureProfiles,
  handleGetProjectRevisionNomenclature,
  handleSetProjectRevisionNomenclature,
  handleCloneProjectRevisionNomenclature,
  handleClearProjectRevisionNomenclature,
} from './revision-nomenclature-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
const TYPES = [{ key: 'bulletin', format: { displayName: 'Bulletin {number}' } }];
const createdProjectIds: string[] = [];

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

async function makeProject(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('wave7d-rev') RETURNING id`
  );
  const id = r.rows[0]!.id;
  createdProjectIds.push(id);
  return id;
}

afterAll(async () => {
  if (createdProjectIds.length > 0) {
    // Cascades revision_nomenclature_profiles owned by the project.
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [createdProjectIds]);
  }
});

describe('revision-nomenclature MCP tools', () => {
  it('lists the built-in profiles', async () => {
    const list = parse<{ id: string; name: string }[]>(
      await handleListRevisionNomenclatureProfiles()
    );
    expect(list.length).toBeGreaterThan(0);
  });

  it('a fresh project inherits the built-in default (inherited=true)', async () => {
    const projectId = await makeProject();
    const res = await handleGetProjectRevisionNomenclature({ projectId });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ inherited: boolean }>(res).inherited).toBe(true);
  });

  it('set then get a project-specific profile (inherited=false)', async () => {
    const projectId = await makeProject();
    const set = await handleSetProjectRevisionNomenclature({
      projectId,
      name: 'Acme',
      types: TYPES,
    });
    expect(isToolError(set)).toBe(false);
    expect(parse<{ name: string }>(set).name).toBe('Acme');

    const got = parse<{ inherited: boolean; name: string }>(
      await handleGetProjectRevisionNomenclature({ projectId })
    );
    expect(got.inherited).toBe(false);
    expect(got.name).toBe('Acme');
  });

  it('clones a profile from a built-in source', async () => {
    const source = parse<{ id: string; name: string }[]>(
      await handleListRevisionNomenclatureProfiles()
    )[0]!;
    const projectId = await makeProject();
    const res = await handleCloneProjectRevisionNomenclature({ projectId, sourceId: source.id });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ name: string }>(res).name).toBe(source.name);
  });

  it('clears a project override (falls back to inherited)', async () => {
    const projectId = await makeProject();
    await handleSetProjectRevisionNomenclature({ projectId, name: 'Temp', types: TYPES });
    const cleared = await handleClearProjectRevisionNomenclature({ projectId });
    expect(isToolError(cleared)).toBe(false);
    expect(parse<{ cleared: boolean }>(cleared).cleared).toBe(true);
    expect(
      parse<{ inherited: boolean }>(await handleGetProjectRevisionNomenclature({ projectId }))
        .inherited
    ).toBe(true);
  });

  it('missing project and unknown clone source are tool errors', async () => {
    expect(isToolError(await handleGetProjectRevisionNomenclature({ projectId: MISSING }))).toBe(
      true
    );
    expect(
      isToolError(
        await handleSetProjectRevisionNomenclature({ projectId: MISSING, name: 'X', types: TYPES })
      )
    ).toBe(true);
    expect(isToolError(await handleClearProjectRevisionNomenclature({ projectId: MISSING }))).toBe(
      true
    );
    const projectId = await makeProject();
    expect(
      isToolError(await handleCloneProjectRevisionNomenclature({ projectId, sourceId: MISSING }))
    ).toBe(true);
  });
});
