import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool, createLibrary } from '../db/index.js';
import {
  handleListDisciplines,
  handleSetLibraryDisciplines,
  handleClearLibraryDisciplines,
  handleListProjectSpecs,
} from './discipline-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-4000-8000-000000000099';

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

afterEach(async () => {
  await pool.query(
    `DELETE FROM discipline_section_rules WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'disc-mcp-%')`
  );
  await pool.query(
    `DELETE FROM project_specs WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'disc-mcp-%')`
  );
  await pool.query(
    `DELETE FROM specs WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'disc-mcp-%')`
  );
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'disc-mcp-%')`
  );
  await pool.query(`DELETE FROM projects WHERE name LIKE 'disc-mcp-%'`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'disc-mcp-%'`);
});

interface DisciplineRow {
  readonly key: string;
  readonly rules: readonly { divisionStart: string; divisionEnd: string }[];
}

describe('discipline MCP tools', () => {
  it('list_disciplines returns the built-in default catalog', async () => {
    const rows = parse<DisciplineRow[]>(await handleListDisciplines({}));
    expect(rows.find((d) => d.key === 'electrical')?.rules).toEqual([
      { divisionStart: '26', divisionEnd: '26' },
    ]);
  });

  it('set_library_disciplines overrides, clear reverts, and unknown keys are rejected', async () => {
    const lib = await createLibrary({ tier: 'client', name: `disc-mcp-${randomUUID()}` });

    const bad = await handleSetLibraryDisciplines({
      libraryId: lib.id,
      rules: [{ discipline: 'not-a-discipline', divisionStart: '26', divisionEnd: '26' }],
    });
    expect(isToolError(bad)).toBe(true);

    const set = await handleSetLibraryDisciplines({
      libraryId: lib.id,
      rules: [{ discipline: 'mechanical', divisionStart: '21', divisionEnd: '23' }],
    });
    const rows = parse<DisciplineRow[]>(set);
    expect(rows.find((d) => d.key === 'mechanical')?.rules).toEqual([
      { divisionStart: '21', divisionEnd: '23' },
    ]);

    const cleared = parse<{ cleared: boolean }>(
      await handleClearLibraryDisciplines({ libraryId: lib.id })
    );
    expect(cleared.cleared).toBe(true);
  });

  it('overlapping ranges are rejected before the write', async () => {
    const lib = await createLibrary({ tier: 'client', name: `disc-mcp-${randomUUID()}` });
    const res = await handleSetLibraryDisciplines({
      libraryId: lib.id,
      rules: [
        { discipline: 'electrical', divisionStart: '26', divisionEnd: '27' },
        { discipline: 'communications', divisionStart: '27', divisionEnd: '28' },
      ],
    });
    expect(isToolError(res)).toBe(true);
  });

  it('list_project_specs resolves disciplines and filters by key', async () => {
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
      [`disc-mcp-${randomUUID()}`]
    );
    const projectId = project.rows[0]!.id;
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, project_id) VALUES ('26 05 19', 'Elec', 'arcat', $1) RETURNING id`,
      [projectId]
    );
    await pool.query(
      `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`,
      [projectId, spec.rows[0]!.id]
    );

    const rows = parse<
      {
        specId: string;
        section: string;
        title: string;
        position: number;
        discipline: string | null;
      }[]
    >(await handleListProjectSpecs({ projectId, discipline: 'electrical' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      section: '26 05 19',
      title: 'Elec',
      position: 1,
      discipline: 'electrical',
    });
    expect(typeof rows[0]!.specId).toBe('string');
  });

  it('rejects unknown library / project ids', async () => {
    expect(isToolError(await handleClearLibraryDisciplines({ libraryId: MISSING }))).toBe(true);
    expect(isToolError(await handleListProjectSpecs({ projectId: MISSING }))).toBe(true);
  });
});
