import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/index.js';
import {
  handleUpdateSpec,
  handleFinalizeSpec,
  handleReopenSpec,
  handleRestoreSpec,
  handleDeleteSpec,
} from './spec-lifecycle-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
let libraryId: string;
let masterId: string;
let copyId: string;
let projectId: string;

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('client', $1) RETURNING id`,
    [`wave4 ${randomUUID()}`]
  );
  libraryId = lib.rows[0]!.id;

  // Master = library-owned (project_id NULL). Withdraw/restore act only on masters.
  const master = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 21 00', 'Master Cabling', 'ufgs', $1) RETURNING id`,
    [libraryId]
  );
  masterId = master.rows[0]!.id;

  // Project copy = project_id set, library_id NULL, parent_spec_id → its master (ADR-030).
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`wave4 ${randomUUID()}`]
  );
  projectId = proj.rows[0]!.id;
  const copy = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id, parent_spec_id, content_version)
     VALUES ('09 91 00', 'Copy Painting', 'ufgs', $1, $2, 1) RETURNING id`,
    [projectId, masterId]
  );
  copyId = copy.rows[0]!.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [[copyId]]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [[masterId]]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
});

describe('spec lifecycle MCP tools', () => {
  it('update_spec renames the master and returns the updated spec', async () => {
    const res = await handleUpdateSpec({ specId: masterId, title: 'Renamed Master' });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ title: string }>(res).title).toBe('Renamed Master');
  });

  it('update_spec rejects an empty patch, a bad uuid, and a missing spec', async () => {
    expect(isToolError(await handleUpdateSpec({ specId: masterId }))).toBe(true); // no fields
    expect(isToolError(await handleUpdateSpec({ specId: 'nope', title: 'x' }))).toBe(true);
    expect(isToolError(await handleUpdateSpec({ specId: MISSING, title: 'x' }))).toBe(true);
  });

  it('finalize_spec → active and reopen_spec → review (idempotent transitions)', async () => {
    const fin = await handleFinalizeSpec({ specId: masterId });
    expect(isToolError(fin)).toBe(false);
    expect(parse<{ onboardingStatus: string }>(fin).onboardingStatus).toBe('active');

    const reo = await handleReopenSpec({ specId: masterId });
    expect(isToolError(reo)).toBe(false);
    expect(parse<{ onboardingStatus: string }>(reo).onboardingStatus).toBe('review');

    // idempotent repeat is still a success
    expect(isToolError(await handleReopenSpec({ specId: masterId }))).toBe(false);
    expect(isToolError(await handleFinalizeSpec({ specId: MISSING }))).toBe(true);
  });

  it('delete_spec withdraws a master then restore_spec brings it back', async () => {
    const del = await handleDeleteSpec({ specId: masterId });
    expect(isToolError(del)).toBe(false);
    const d = parse<{ specId: string; withdrawnAt: string }>(del);
    expect(d.specId).toBe(masterId);
    expect(d.withdrawnAt).toBeTruthy();

    const w = await pool.query<{ withdrawn_at: Date | null }>(
      'SELECT withdrawn_at FROM specs WHERE id = $1',
      [masterId]
    );
    expect(w.rows[0]?.withdrawn_at).not.toBeNull();

    const restored = await handleRestoreSpec({ specId: masterId });
    expect(isToolError(restored)).toBe(false);
    expect(parse<{ specId: string }>(restored).specId).toBe(masterId);
  });

  it('delete_spec and restore_spec reject a project copy (library masters only)', async () => {
    expect(isToolError(await handleDeleteSpec({ specId: copyId }))).toBe(true);
    expect(isToolError(await handleRestoreSpec({ specId: copyId }))).toBe(true);
  });

  it('delete_spec and restore_spec return a tool error for a missing spec', async () => {
    expect(isToolError(await handleDeleteSpec({ specId: MISSING }))).toBe(true);
    expect(isToolError(await handleRestoreSpec({ specId: MISSING }))).toBe(true);
  });
});
