import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/index.js';
import {
  handleListConventions,
  handleGetLibraryConventions,
  handleSetLibraryConventions,
  handleCloneConventions,
} from './convention-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
const createdLibraryIds: string[] = [];

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

async function insertLibrary(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('client', $1) RETURNING id`,
    [`wave7b ${randomUUID()}`]
  );
  const id = r.rows[0]!.id;
  createdLibraryIds.push(id);
  return id;
}

afterAll(async () => {
  if (createdLibraryIds.length > 0) {
    // editing_conventions references libraries — drop the library-owned rows first.
    await pool.query('DELETE FROM editing_conventions WHERE library_id = ANY($1::uuid[])', [
      createdLibraryIds,
    ]);
    await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [createdLibraryIds]);
  }
});

describe('convention MCP tools', () => {
  it('lists the built-in conventions (incl. Industry Default)', async () => {
    const list = parse<{ id: string; name: string }[]>(await handleListConventions());
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((c) => c.name === 'Industry Default')).toBe(true);
  });

  it('a fresh library inherits the built-in default (inherited=true)', async () => {
    const libraryId = await insertLibrary();
    const res = await handleGetLibraryConventions({ libraryId });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ inherited: boolean }>(res).inherited).toBe(true);
  });

  it('set then get a library-specific convention (inherited=false)', async () => {
    const libraryId = await insertLibrary();
    const name = `wave7b-conv-${randomUUID().slice(0, 8)}`;
    const set = await handleSetLibraryConventions({ libraryId, name });
    expect(isToolError(set)).toBe(false);
    expect(parse<{ name: string }>(set).name).toBe(name);

    const got = parse<{ inherited: boolean; name: string }>(
      await handleGetLibraryConventions({ libraryId })
    );
    expect(got.inherited).toBe(false);
    expect(got.name).toBe(name);
  });

  it('clones a convention from the built-in default into a library', async () => {
    const source = parse<{ id: string; name: string }[]>(await handleListConventions())[0]!;
    const libraryId = await insertLibrary();
    const res = await handleCloneConventions({ libraryId, sourceId: source.id });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ name: string }>(res).name).toBe(source.name);
    // the library now owns a profile
    const got = parse<{ inherited: boolean }>(await handleGetLibraryConventions({ libraryId }));
    expect(got.inherited).toBe(false);
  });

  it('missing library and unknown clone source are tool errors', async () => {
    expect(isToolError(await handleGetLibraryConventions({ libraryId: MISSING }))).toBe(true);
    expect(isToolError(await handleSetLibraryConventions({ libraryId: MISSING, name: 'x' }))).toBe(
      true
    );
    const libraryId = await insertLibrary();
    expect(isToolError(await handleCloneConventions({ libraryId, sourceId: MISSING }))).toBe(true);
  });

  it('rejects an unsafe (ReDoS) regex in the rules', async () => {
    const libraryId = await insertLibrary();
    const res = await handleSetLibraryConventions({
      libraryId,
      name: 'Unsafe',
      rules: { noteBanners: ['(a+)+$'] },
    });
    expect(isToolError(res)).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain('regex');
  });
});
