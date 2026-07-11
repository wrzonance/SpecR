import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import {
  handleListLibraryStandards,
  handleListProjectStandards,
  handleRecordStandardVerification,
} from './standards-handlers.js';
import type { ToolResult } from './tool-result.js';
import type { StandardsRollup, StandardRecord } from '../db/index.js';

const suffix = randomUUID().slice(0, 8);
const ORG = `TSTC${suffix.toUpperCase()}`; // synthetic org isolates registry writes
const specIds: string[] = [];
let projectId: string;
let libraryId: string;

function parse<T>(res: ToolResult): T {
  if ('isError' in res && res.isError) throw new Error(res.content[0]?.text ?? 'error');
  return JSON.parse(res.content[0]!.text) as T;
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`Std MCP Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`Std MCP Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ('26 05 00','Common Work Results',$1,$2) RETURNING id`,
    [suffix, libraryId]
  );
  const specId = s.rows[0]!.id;
  specIds.push(specId);
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1)`, [
    projectId,
    specId,
  ]);
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1,'pr1','x',1) RETURNING id`,
    [specId]
  );
  await pool.query(
    `INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type, standard_code, reference_text)
     VALUES ($1,$2,'standard',$3,$4)`,
    [specId, p.rows[0]!.id, `${ORG} 70`, `${ORG} 70`]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM standards WHERE org_code = $1', [ORG]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
});

describe('standards MCP tools', () => {
  it('list_library_standards compiles the cited standard', async () => {
    const rollup = parse<StandardsRollup>(await handleListLibraryStandards({ libraryId }));
    expect(rollup.standards.map((s) => `${s.orgCode} ${s.standardCode}`)).toEqual([`${ORG} 70`]);
  });

  it('list_project_standards compiles the cited standard', async () => {
    const rollup = parse<StandardsRollup>(await handleListProjectStandards({ projectId }));
    expect(rollup.standards).toHaveLength(1);
  });

  it('record_standard_verification upserts and the verdict shows in the next rollup', async () => {
    const rec = parse<StandardRecord>(
      await handleRecordStandardVerification({
        orgCode: ORG,
        standardCode: '70',
        status: 'withdrawn',
      })
    );
    expect(rec.status).toBe('withdrawn');
    expect(rec.lastVerifiedAt).not.toBeNull();

    const rollup = parse<StandardsRollup>(await handleListLibraryStandards({ libraryId }));
    expect(rollup.standards[0]?.status).toBe('withdrawn');
    expect(rollup.findings.some((f) => f.type === 'standard_withdrawn')).toBe(true);
  });

  it('rejects malformed input and unknown scopes as tool errors', async () => {
    expect('isError' in (await handleListLibraryStandards({ libraryId: 'nope' }))).toBe(true);
    const unknown = await handleListProjectStandards({ projectId: randomUUID() });
    expect('isError' in unknown && unknown.isError).toBe(true);
    expect(
      'isError' in (await handleRecordStandardVerification({ orgCode: '', standardCode: '70' }))
    ).toBe(true);
  });
});
