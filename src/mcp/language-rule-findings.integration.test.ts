import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, createLibrary } from '../db/index.js';
import { handleSetLibraryLanguageRules } from './language-rule-handlers.js';
import { handleGetLanguageFindings } from './language-rule-findings-handlers.js';
import type { ToolResult } from './handlers.js';

// #411 / ADR-080 — mirrors src/api/language-rule-findings.integration.test.ts's
// fixture, driven through the MCP tool boundary instead of REST.

let libraryId: string;
let projectId: string;
let specId: string;
const suffix = randomUUID().slice(0, 8);

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

beforeAll(async () => {
  const library = await createLibrary({ tier: 'client', name: `lang-find-mcp-${suffix}` });
  libraryId = library.id;

  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('05 12 00', 'Steel', $1, $2)
     RETURNING id`,
    [`langmcp_${suffix}`, libraryId]
  );
  specId = spec.rows[0]!.id;
  await pool.query(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'pr1', 'The Contractor shall furnish all labor.', 1)`,
    [specId]
  );

  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`lang-find-mcp-${suffix}`]
  );
  projectId = project.rows[0]!.id;
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await pool.query(`DELETE FROM language_rule_profiles WHERE library_id = $1`, [libraryId]);
  await pool.query(`DELETE FROM libraries WHERE id = $1`, [libraryId]);
});

interface FindingsReport {
  readonly configured: boolean;
  readonly findings: readonly unknown[];
  readonly summary: { readonly total: number };
  readonly notes: readonly string[];
}

describe('get_language_findings MCP tool', () => {
  it('configured:false with empty findings when nothing is configured anywhere', async () => {
    const res = await handleGetLanguageFindings({ projectId });
    expect(isToolError(res)).toBe(false);
    const report = parse<FindingsReport>(res);
    expect(report.configured).toBe(false);
    expect(report.findings).toEqual([]);
    expect(report.notes.length).toBeGreaterThan(0);
  });

  it('reports a bannedTerm finding once the authoring library has a profile', async () => {
    const set = await handleSetLibraryLanguageRules({
      libraryId,
      rules: { bannedTerms: [{ term: 'shall', suggestion: 'will' }] },
    });
    expect(isToolError(set)).toBe(false);

    const res = await handleGetLanguageFindings({ projectId });
    expect(isToolError(res)).toBe(false);
    const report = parse<FindingsReport>(res);
    expect(report.configured).toBe(true);
    expect(report.summary.total).toBeGreaterThan(0);

    await pool.query(`DELETE FROM language_rule_profiles WHERE library_id = $1`, [libraryId]);
  });

  it('unknown project is a tool error, not a throw', async () => {
    const res = await handleGetLanguageFindings({
      projectId: '00000000-0000-4000-8000-000000000000',
    });
    expect(isToolError(res)).toBe(true);
  });

  it('unknown packageId is a tool error, not a throw', async () => {
    const res = await handleGetLanguageFindings({
      projectId,
      packageId: '00000000-0000-4000-8000-000000000000',
    });
    expect(isToolError(res)).toBe(true);
  });

  it('validation error names the field that failed — a bad packageId is not reported as projectId', async () => {
    const res = await handleGetLanguageFindings({ projectId, packageId: 'not-a-uuid' });
    expect(isToolError(res)).toBe(true);
    const message = res.content[0]?.text ?? '';
    expect(message).toContain('packageId');
    expect(message).not.toContain('projectId');
  });
});
