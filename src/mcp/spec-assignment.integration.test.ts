import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool, createTemplate, createNumberingProfile } from '../db/index.js';
import type { NumberingProfile } from '../ast/index.js';
import { handleGetSpecLock, handleLockSpec, handleUnlockSpec } from './lock-handlers.js';
import {
  handleAssignStyleSource,
  handleClearStyleSource,
  handleAssignNumberingProfile,
  handleClearNumberingProfile,
} from './assignment-handlers.js';
import type { ToolResult } from './handlers.js';

const MINIMAL_RULES: NumberingProfile = {
  tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
  numbering: [],
  styleLadder: [],
};
const MISSING = '00000000-0000-0000-0000-000000000000';

let libraryId: string;
let otherLibraryId: string;
let specId: string;
let templateId: string;
let otherTemplateId: string;
let profileId: string;
let otherProfileId: string;

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}
function errorText(res: ToolResult): string {
  return res.content[0]!.text;
}

async function insertLibrary(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('client', $1) RETURNING id`,
    [`wave6 ${randomUUID()}`]
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  libraryId = await insertLibrary();
  otherLibraryId = await insertLibrary();
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 21 00', 'Assign Cabling', 'ufgs', $1) RETURNING id`,
    [libraryId]
  );
  specId = spec.rows[0]!.id;
  templateId = (await createTemplate(`wave6-tmpl-${randomUUID().slice(0, 8)}`)).id;
  // #318 — a template scoped to the OTHER library, to prove the cross-library guard.
  otherTemplateId = (
    await createTemplate(`wave6-other-tmpl-${randomUUID().slice(0, 8)}`, undefined, otherLibraryId)
  ).id;
  profileId = (
    await createNumberingProfile(libraryId, `wave6-prof-${randomUUID().slice(0, 8)}`, MINIMAL_RULES)
  ).id;
  otherProfileId = (
    await createNumberingProfile(
      otherLibraryId,
      `wave6-other-${randomUUID().slice(0, 8)}`,
      MINIMAL_RULES
    )
  ).id;
});

afterAll(async () => {
  // Spec first (drops its style/profile assignments), then the referenced rows.
  await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
  await pool.query('DELETE FROM numbering_profiles WHERE id = ANY($1::uuid[])', [
    [profileId, otherProfileId],
  ]);
  await pool.query('DELETE FROM style_templates WHERE id = ANY($1::uuid[])', [
    [templateId, otherTemplateId],
  ]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [
    [libraryId, otherLibraryId],
  ]);
});

describe('spec lock MCP tools', () => {
  it('lifecycle: unlocked → lock → locked → unlock → unlocked', async () => {
    expect(parse<{ locked: boolean }>(await handleGetSpecLock({ specId })).locked).toBe(false);

    const acquired = await handleLockSpec({ specId, holder: 'alice' });
    expect(isToolError(acquired)).toBe(false);

    expect(parse<{ locked: boolean }>(await handleGetSpecLock({ specId })).locked).toBe(true);

    const released = await handleUnlockSpec({ specId, holder: 'alice' });
    expect(isToolError(released)).toBe(false);
    expect(parse<{ released: boolean }>(released).released).toBe(true);

    expect(parse<{ locked: boolean }>(await handleGetSpecLock({ specId })).locked).toBe(false);
  });

  it('a live lock held by another holder blocks lock_spec', async () => {
    expect(isToolError(await handleLockSpec({ specId, holder: 'alice' }))).toBe(false);
    expect(isToolError(await handleLockSpec({ specId, holder: 'bob' }))).toBe(true); // held by alice
    expect(isToolError(await handleUnlockSpec({ specId, holder: 'alice' }))).toBe(false);
  });

  it('unlock with no held lock and lock on a missing spec are tool errors', async () => {
    expect(isToolError(await handleUnlockSpec({ specId, holder: 'nobody' }))).toBe(true);
    expect(isToolError(await handleLockSpec({ specId: MISSING, holder: 'alice' }))).toBe(true);
  });
});

describe('style-source MCP tools', () => {
  it('assign then clear a style template (idempotent clear)', async () => {
    const assigned = await handleAssignStyleSource({ specId, templateId });
    expect(isToolError(assigned)).toBe(false);
    expect(parse<{ templateId: string }>(assigned).templateId).toBe(templateId);

    const cleared = await handleClearStyleSource({ specId });
    expect(isToolError(cleared)).toBe(false);
    expect(parse<{ styleSource: null }>(cleared).styleSource).toBeNull();
  });

  it('assign with an unknown template and clear on a missing spec are tool errors', async () => {
    expect(isToolError(await handleAssignStyleSource({ specId, templateId: MISSING }))).toBe(true);
    expect(isToolError(await handleClearStyleSource({ specId: MISSING }))).toBe(true);
  });

  it('a template from a different library is rejected (library mismatch) (#318)', async () => {
    const res = await handleAssignStyleSource({ specId, templateId: otherTemplateId });
    expect(isToolError(res)).toBe(true);
    expect(errorText(res)).toContain('style template belongs to a different library than the spec');
  });
});

describe('numbering-profile MCP tools', () => {
  it('assign a same-library profile then clear it', async () => {
    const assigned = await handleAssignNumberingProfile({ specId, profileId });
    expect(isToolError(assigned)).toBe(false);
    expect(parse<{ profileId: string }>(assigned).profileId).toBe(profileId);

    const cleared = await handleClearNumberingProfile({ specId });
    expect(isToolError(cleared)).toBe(false);
    expect(parse<{ cleared: boolean }>(cleared).cleared).toBe(true);
  });

  it('a profile from a different library is rejected (library mismatch)', async () => {
    expect(
      isToolError(await handleAssignNumberingProfile({ specId, profileId: otherProfileId }))
    ).toBe(true);
  });

  it('assign with an unknown profile and clear on a missing spec are tool errors', async () => {
    expect(isToolError(await handleAssignNumberingProfile({ specId, profileId: MISSING }))).toBe(
      true
    );
    expect(isToolError(await handleClearNumberingProfile({ specId: MISSING }))).toBe(true);
  });
});
