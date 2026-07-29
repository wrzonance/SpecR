import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/index.js';
import {
  handleGetLibraryLanguageRules,
  handleSetLibraryLanguageRules,
  handleClearLibraryLanguageRules,
  handleGetProjectLanguageRules,
  handleSetProjectLanguageRules,
  handleClearProjectLanguageRules,
} from './language-rule-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
const createdLibraryIds: string[] = [];
const createdProjectIds: string[] = [];

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

async function insertLibrary(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('client', $1) RETURNING id`,
    [`lang-mcp ${randomUUID()}`]
  );
  const id = r.rows[0]!.id;
  createdLibraryIds.push(id);
  return id;
}

async function insertProject(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`lang-mcp ${randomUUID()}`]
  );
  const id = r.rows[0]!.id;
  createdProjectIds.push(id);
  return id;
}

afterAll(async () => {
  if (createdLibraryIds.length > 0) {
    await pool.query('DELETE FROM language_rule_profiles WHERE library_id = ANY($1::uuid[])', [
      createdLibraryIds,
    ]);
    await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [createdLibraryIds]);
  }
  if (createdProjectIds.length > 0) {
    await pool.query('DELETE FROM language_rule_profiles WHERE project_id = ANY($1::uuid[])', [
      createdProjectIds,
    ]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [createdProjectIds]);
  }
});

describe('language-rule profile MCP tools — library scope', () => {
  it('a fresh library has no profile configured (isError)', async () => {
    const libraryId = await insertLibrary();
    const res = await handleGetLibraryLanguageRules({ libraryId });
    expect(isToolError(res)).toBe(true);
  });

  it('set then get round-trips the stored rules', async () => {
    const libraryId = await insertLibrary();
    const rules = { bannedTerms: [{ term: 'shall', suggestion: 'will' }] };
    const set = await handleSetLibraryLanguageRules({ libraryId, rules });
    expect(isToolError(set)).toBe(false);
    expect(parse<{ rules: unknown }>(set).rules).toEqual(rules);

    const got = parse<{ rules: unknown }>(await handleGetLibraryLanguageRules({ libraryId }));
    expect(got.rules).toEqual(rules);
  });

  it('clear removes the profile (subsequent get is isError)', async () => {
    const libraryId = await insertLibrary();
    await handleSetLibraryLanguageRules({ libraryId, rules: { bannedTerms: [{ term: 'x' }] } });

    const cleared = await handleClearLibraryLanguageRules({ libraryId });
    expect(isToolError(cleared)).toBe(false);
    expect(parse<{ libraryId: string; cleared: boolean }>(cleared)).toEqual({
      libraryId,
      cleared: true,
    });

    expect(isToolError(await handleGetLibraryLanguageRules({ libraryId }))).toBe(true);
  });

  it('missing library and unknown owner are tool errors, not throws', async () => {
    expect(isToolError(await handleGetLibraryLanguageRules({ libraryId: MISSING }))).toBe(true);
    expect(
      isToolError(
        await handleSetLibraryLanguageRules({
          libraryId: MISSING,
          rules: { bannedTerms: [{ term: 'x' }] },
        })
      )
    ).toBe(true);
    expect(isToolError(await handleClearLibraryLanguageRules({ libraryId: MISSING }))).toBe(true);
  });

  it('rejects an unsafe (ReDoS) isRegex term', async () => {
    const libraryId = await insertLibrary();
    const res = await handleSetLibraryLanguageRules({
      libraryId,
      rules: { bannedTerms: [{ term: '(a+)+$', isRegex: true }] },
    });
    expect(isToolError(res)).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain('regex');
  });
});

describe('language-rule profile MCP tools — project scope', () => {
  it('a fresh project has no profile configured (isError)', async () => {
    const projectId = await insertProject();
    const res = await handleGetProjectLanguageRules({ projectId });
    expect(isToolError(res)).toBe(true);
  });

  it('set then get round-trips the stored rules', async () => {
    const projectId = await insertProject();
    const rules = { requiredPhrases: [{ term: 'Contract Documents' }] };
    const set = await handleSetProjectLanguageRules({ projectId, rules });
    expect(isToolError(set)).toBe(false);
    expect(parse<{ rules: unknown }>(set).rules).toEqual(rules);

    const got = parse<{ rules: unknown }>(await handleGetProjectLanguageRules({ projectId }));
    expect(got.rules).toEqual(rules);
  });

  it('clear removes the profile (subsequent get is isError)', async () => {
    const projectId = await insertProject();
    await handleSetProjectLanguageRules({
      projectId,
      rules: { reinforcingWords: [{ term: 'very' }] },
    });

    const cleared = await handleClearProjectLanguageRules({ projectId });
    expect(isToolError(cleared)).toBe(false);
    expect(parse<{ projectId: string; cleared: boolean }>(cleared)).toEqual({
      projectId,
      cleared: true,
    });

    expect(isToolError(await handleGetProjectLanguageRules({ projectId }))).toBe(true);
  });

  it('missing project is a tool error, not a throw', async () => {
    expect(isToolError(await handleGetProjectLanguageRules({ projectId: MISSING }))).toBe(true);
    expect(
      isToolError(
        await handleSetProjectLanguageRules({
          projectId: MISSING,
          rules: { bannedTerms: [{ term: 'x' }] },
        })
      )
    ).toBe(true);
  });
});
