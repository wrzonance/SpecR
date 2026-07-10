import { describe, it, expect, afterAll } from 'vitest';
import { pool, createLibrary, createSpec, withdrawSpec } from '../db/index.js';
import {
  handleListLibrarySpecs,
  handleRenameLibrary,
  handleCreateClientLibrary,
} from './library-management-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-4000-8000-000000000099';

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

let seq = 0;
// libraries.name is UNIQUE — every fixture name is distinct and shares the prefix
// so afterAll cleanup catches it.
const uniq = (part: string): string => {
  seq += 1;
  return `lm-mcp-test-${part}-${seq}`;
};

afterAll(async () => {
  // FK-safe: specs → client libraries (children) → remaining libraries (parents).
  await pool.query(`DELETE FROM specs WHERE title LIKE 'lm-mcp-test-%'`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lm-mcp-test-%' AND tier = 'client'`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lm-mcp-test-%'`);
});

interface LibraryShape {
  id: string;
  tier: string;
  name: string;
  owner: string | null;
  parentLibraryId: string | null;
}

describe('library-management MCP tools', () => {
  it('lists a library’s specs', async () => {
    const lib = await createLibrary({ tier: 'client', name: uniq('list') });
    await createSpec({
      section: '07 21 16',
      title: uniq('spec'),
      source: 'arcat',
      libraryId: lib.id,
    });
    const rows = parse<{ section: string }[]>(await handleListLibrarySpecs({ libraryId: lib.id }));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('list_library_specs rejects a bad UUID and an unknown library', async () => {
    expect(isToolError(await handleListLibrarySpecs({ libraryId: 'nope' }))).toBe(true);
    expect(isToolError(await handleListLibrarySpecs({ libraryId: MISSING }))).toBe(true);
  });

  it('list_library_specs hides withdrawn masters by default, surfaces them with includeWithdrawn', async () => {
    const lib = await createLibrary({ tier: 'client', name: uniq('withdrawn') });
    const active = await createSpec({
      section: '07 21 00',
      title: uniq('active'),
      source: 'arcat',
      libraryId: lib.id,
    });
    const withdrawn = await createSpec({
      section: '07 21 16',
      title: uniq('withdrawn'),
      source: 'arcat',
      libraryId: lib.id,
    });
    await withdrawSpec(withdrawn);

    type Row = { specId: string; withdrawnAt: string | null };
    const byDefault = parse<Row[]>(await handleListLibrarySpecs({ libraryId: lib.id }));
    expect(byDefault.map((r) => r.specId)).toEqual([active]);
    expect(byDefault[0]?.withdrawnAt).toBeNull();

    const all = parse<Row[]>(
      await handleListLibrarySpecs({ libraryId: lib.id, includeWithdrawn: true })
    );
    const byId = (a: string, b: string): number => a.localeCompare(b);
    expect(all.map((r) => r.specId).sort(byId)).toEqual([active, withdrawn].sort(byId));
    expect(typeof all.find((r) => r.specId === withdrawn)?.withdrawnAt).toBe('string');
  });

  it('renames a client library', async () => {
    const lib = await createLibrary({ tier: 'client', name: uniq('rename-old') });
    const newName = uniq('rename-new');
    const res = await handleRenameLibrary({ libraryId: lib.id, name: newName });
    expect(isToolError(res)).toBe(false);
    expect(parse<LibraryShape>(res).name).toBe(newName);
  });

  it('rename rejects bad input, unknown id, and a non-client library', async () => {
    expect(isToolError(await handleRenameLibrary({ libraryId: 'nope', name: 'x' }))).toBe(true);
    expect(isToolError(await handleRenameLibrary({ libraryId: MISSING, name: 'x' }))).toBe(true);
    const company = await createLibrary({ tier: 'company', name: uniq('company') });
    expect(isToolError(await handleRenameLibrary({ libraryId: company.id, name: 'x' }))).toBe(true);
  });

  it('rename rejects a name collision', async () => {
    const taken = await createLibrary({ tier: 'client', name: uniq('taken') });
    const other = await createLibrary({ tier: 'client', name: uniq('other') });
    expect(isToolError(await handleRenameLibrary({ libraryId: other.id, name: taken.name }))).toBe(
      true
    );
  });

  it('creates a client library under the default company parent (owner = name)', async () => {
    const res = await handleCreateClientLibrary({ name: uniq('client-default') });
    expect(isToolError(res)).toBe(false);
    const lib = parse<LibraryShape>(res);
    expect(lib.tier).toBe('client');
    expect(lib.owner).toBe(lib.name);
  });

  it('creates a client library under an explicit company parent', async () => {
    const parent = await createLibrary({ tier: 'company', name: uniq('parent') });
    const res = await handleCreateClientLibrary({
      name: uniq('client-explicit'),
      parentLibraryId: parent.id,
    });
    expect(isToolError(res)).toBe(false);
    expect(parse<LibraryShape>(res).parentLibraryId).toBe(parent.id);
  });

  it('create_client_library rejects blank name, unknown parent, non-company parent, and collision', async () => {
    expect(isToolError(await handleCreateClientLibrary({ name: '' }))).toBe(true);
    expect(
      isToolError(await handleCreateClientLibrary({ name: uniq('x'), parentLibraryId: MISSING }))
    ).toBe(true);
    const client = await createLibrary({ tier: 'client', name: uniq('nonparent') });
    expect(
      isToolError(await handleCreateClientLibrary({ name: uniq('y'), parentLibraryId: client.id }))
    ).toBe(true);
    const taken = await createLibrary({ tier: 'client', name: uniq('dup') });
    expect(isToolError(await handleCreateClientLibrary({ name: taken.name }))).toBe(true);
  });
});
