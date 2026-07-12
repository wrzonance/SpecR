import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool, createLibrary, createSpec, setSpecNumberingProfile } from '../db/index.js';
import type { NumberingProfile } from '../ast/index.js';
import {
  handleListLibraryNumberingProfiles,
  handleCreateLibraryNumberingProfile,
  handleGetNumberingProfileById,
  handleUpdateNumberingProfile,
  handleDeleteNumberingProfile,
  handleSnapshotNumberingProfile,
} from './numbering-profile-crud-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-4000-8000-000000000099';
const DOCX_FIXTURE = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');
const RULES: NumberingProfile = {
  tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
  numbering: [],
  styleLadder: [],
};

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

interface ProfileRow {
  id: string;
  name: string;
  libraryId: string | null;
}

let libCounter = 0;
async function makeLibrary(): Promise<string> {
  // libraries.name is UNIQUE — give each fixture library a distinct name.
  libCounter += 1;
  const lib = await createLibrary({ tier: 'client', name: `np-mcp-test-lib-${libCounter}` });
  return lib.id;
}

async function builtInProfileId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM numbering_profiles WHERE library_id IS NULL LIMIT 1`
  );
  return r.rows[0]!.id;
}

afterAll(async () => {
  // FK-safe: clear spec refs → delete specs → delete libraries (CASCADEs their profiles).
  await pool.query(`UPDATE specs SET numbering_profile_id = NULL WHERE title LIKE 'np-mcp-test-%'`);
  await pool.query(`DELETE FROM specs WHERE title LIKE 'np-mcp-test-%'`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'np-mcp-test-%'`);
});

describe('numbering-profile CRUD MCP tools', () => {
  it('lists a library’s profiles including the built-in CSI Default', async () => {
    const libraryId = await makeLibrary();
    await handleCreateLibraryNumberingProfile({ libraryId, name: 'Listed', rules: RULES });
    const rows = parse<ProfileRow[]>(await handleListLibraryNumberingProfiles({ libraryId }));
    const names = rows.map((p) => p.name);
    expect(names).toContain('Listed');
    expect(names).toContain('CSI Default');
  });

  it('list rejects a bad UUID and an unknown library', async () => {
    expect(isToolError(await handleListLibraryNumberingProfiles({ libraryId: 'nope' }))).toBe(true);
    expect(isToolError(await handleListLibraryNumberingProfiles({ libraryId: MISSING }))).toBe(
      true
    );
  });

  it('creates a profile, then reads it back by id', async () => {
    const libraryId = await makeLibrary();
    const created = parse<ProfileRow>(
      await handleCreateLibraryNumberingProfile({ libraryId, name: 'Created', rules: RULES })
    );
    expect(created.libraryId).toBe(libraryId);
    const got = parse<ProfileRow>(await handleGetNumberingProfileById({ profileId: created.id }));
    expect(got.name).toBe('Created');
  });

  it('create rejects an unknown library (FK) and a missing rules field', async () => {
    expect(
      isToolError(
        await handleCreateLibraryNumberingProfile({ libraryId: MISSING, name: 'X', rules: RULES })
      )
    ).toBe(true);
    const libraryId = await makeLibrary();
    expect(
      isToolError(await handleCreateLibraryNumberingProfile({ libraryId, name: 'no-rules' }))
    ).toBe(true);
  });

  it('create rejects a divergent declared tier, naming the offending entry (#319)', async () => {
    const libraryId = await makeLibrary();
    const res = await handleCreateLibraryNumberingProfile({
      libraryId,
      name: 'Divergent',
      rules: {
        tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
        // ilvl=1 with articleIlvl=1 derives to 'article' — the declared
        // 'subparagraph' is inconsistent, so the parse must reject it (#319).
        numbering: [{ numId: 1, levels: [{ ilvl: 1, tier: 'subparagraph' }] }],
        styleLadder: [],
        articleIlvl: 1,
      },
    });
    expect(isToolError(res)).toBe(true);
    const message = res.content[0]!.text;
    expect(message).toContain('numId=1');
    expect(message).toContain("declares tier 'subparagraph'");
    expect(message).toContain("derives to 'article'");
  });

  it('get rejects a bad UUID and an unknown id', async () => {
    expect(isToolError(await handleGetNumberingProfileById({ profileId: 'nope' }))).toBe(true);
    expect(isToolError(await handleGetNumberingProfileById({ profileId: MISSING }))).toBe(true);
  });

  it('updates a profile’s name', async () => {
    const libraryId = await makeLibrary();
    const created = parse<ProfileRow>(
      await handleCreateLibraryNumberingProfile({ libraryId, name: 'Old', rules: RULES })
    );
    const updated = parse<ProfileRow>(
      await handleUpdateNumberingProfile({ profileId: created.id, name: 'New' })
    );
    expect(updated.name).toBe('New');
  });

  it('update rejects unknown id, the protected built-in, and a blank name', async () => {
    expect(isToolError(await handleUpdateNumberingProfile({ profileId: MISSING, name: 'X' }))).toBe(
      true
    );
    const builtIn = await builtInProfileId();
    const guard = await handleUpdateNumberingProfile({ profileId: builtIn, name: 'hijack' });
    expect(isToolError(guard)).toBe(true);
    const libraryId = await makeLibrary();
    const created = parse<ProfileRow>(
      await handleCreateLibraryNumberingProfile({ libraryId, name: 'Blank test', rules: RULES })
    );
    expect(
      isToolError(await handleUpdateNumberingProfile({ profileId: created.id, name: '  ' }))
    ).toBe(true);
  });

  it('update rejects a divergent declared tier, naming the offending entry (#319)', async () => {
    const libraryId = await makeLibrary();
    const created = parse<ProfileRow>(
      await handleCreateLibraryNumberingProfile({ libraryId, name: 'Update Target', rules: RULES })
    );
    const res = await handleUpdateNumberingProfile({
      profileId: created.id,
      rules: {
        tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
        numbering: [],
        // ilvl=2 with articleIlvl=1 derives to 'paragraph' — the declared
        // 'part' is inconsistent, so the parse must reject it (#319).
        styleLadder: [{ styleId: 'PR1', numId: 1, ilvl: 2, tier: 'part' }],
        articleIlvl: 1,
      },
    });
    expect(isToolError(res)).toBe(true);
    const message = res.content[0]!.text;
    expect(message).toContain('styleId=PR1');
    expect(message).toContain("declares tier 'part'");
    expect(message).toContain("derives to 'paragraph'");
  });

  it('deletes an unreferenced profile', async () => {
    const libraryId = await makeLibrary();
    const created = parse<ProfileRow>(
      await handleCreateLibraryNumberingProfile({ libraryId, name: 'Delete Me', rules: RULES })
    );
    const res = await handleDeleteNumberingProfile({ profileId: created.id });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ deleted: boolean }>(res).deleted).toBe(true);
    // Gone now → subsequent get is a tool error.
    expect(isToolError(await handleGetNumberingProfileById({ profileId: created.id }))).toBe(true);
  });

  it('delete rejects unknown id, the protected built-in, and an in-use profile', async () => {
    expect(isToolError(await handleDeleteNumberingProfile({ profileId: MISSING }))).toBe(true);
    const builtIn = await builtInProfileId();
    expect(isToolError(await handleDeleteNumberingProfile({ profileId: builtIn }))).toBe(true);

    const libraryId = await makeLibrary();
    const profile = parse<ProfileRow>(
      await handleCreateLibraryNumberingProfile({ libraryId, name: 'In Use', rules: RULES })
    );
    const specId = await createSpec({
      section: '07 21 16',
      title: 'np-mcp-test-in-use',
      source: 'arcat',
      libraryId,
    });
    await setSpecNumberingProfile(specId, profile.id);
    expect(isToolError(await handleDeleteNumberingProfile({ profileId: profile.id }))).toBe(true);
  });

  it('snapshots a numbering profile from a base64 .docx without persisting', async () => {
    const contentBase64 = readFileSync(DOCX_FIXTURE).toString('base64');
    const res = await handleSnapshotNumberingProfile({ contentBase64 });
    expect(isToolError(res)).toBe(false);
    expect(parse<NumberingProfile>(res).tiers).toBeDefined();
  });

  it('snapshot rejects invalid base64 and a non-.docx payload', async () => {
    expect(
      isToolError(await handleSnapshotNumberingProfile({ contentBase64: 'not base64!!' }))
    ).toBe(true);
    // Valid base64, but the bytes are not a DOCX (fails assertDocxSafe).
    const notDocx = Buffer.from('hello world, not a zip').toString('base64');
    expect(isToolError(await handleSnapshotNumberingProfile({ contentBase64: notDocx }))).toBe(
      true
    );
  });
});
