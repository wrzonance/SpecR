import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { randomUUID } from 'node:crypto';
import {
  getSpecStyleSource,
  setSpecStyleSource,
  clearSpecStyleSource,
  countSpecsUsingTemplate,
} from './style-source.js';
import { createLibrary } from './libraries.js';
import { createSpec } from './specs.js';

const CREATED_TEMPLATE_NAMES: string[] = [];
const CREATED_SPEC_IDS: string[] = [];
const CREATED_LIBRARY_IDS: string[] = [];

afterEach(async () => {
  // Specs first — they reference templates (RESTRICT).
  if (CREATED_SPEC_IDS.length > 0) {
    await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [CREATED_SPEC_IDS]);
    CREATED_SPEC_IDS.length = 0;
  }
  if (CREATED_TEMPLATE_NAMES.length > 0) {
    await pool.query(`DELETE FROM style_templates WHERE name = ANY($1::text[])`, [
      CREATED_TEMPLATE_NAMES,
    ]);
    CREATED_TEMPLATE_NAMES.length = 0;
  }
  // Libraries last — deleting one CASCADEs to its (library-scoped) style_templates,
  // now that the specs referencing them are gone (RESTRICT satisfied).
  if (CREATED_LIBRARY_IDS.length > 0) {
    await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [CREATED_LIBRARY_IDS]);
    CREATED_LIBRARY_IDS.length = 0;
  }
});

// Built-in / global template (library_id NULL) — the pre-#318 default.
async function makeTemplate(name: string): Promise<string> {
  CREATED_TEMPLATE_NAMES.push(name);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO style_templates (name) VALUES ($1) RETURNING id`,
    [name]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert template');
  return id;
}

// Library-scoped template (#318): library_id set, so it only binds that library's specs.
async function makeScopedTemplate(name: string, libraryId: string): Promise<string> {
  CREATED_TEMPLATE_NAMES.push(name);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO style_templates (name, library_id) VALUES ($1, $2) RETURNING id`,
    [name, libraryId]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert scoped template');
  return id;
}

async function makeLibrary(name: string): Promise<string> {
  const lib = await createLibrary({ tier: 'client', name });
  CREATED_LIBRARY_IDS.push(lib.id);
  return lib.id;
}

async function makeSpecInLibrary(libraryId: string): Promise<string> {
  const id = await createSpec({
    section: '27 21 00',
    title: 'ss-test-scoped-spec',
    source: `ss-${randomUUID().slice(0, 8)}`,
    libraryId,
  });
  CREATED_SPEC_IDS.push(id);
  return id;
}

async function makeSpec(): Promise<string> {
  // Unique source per spec — (section, source, library_id) is uniquely constrained.
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    ['27 21 00', 'Style Source Test Spec', `ss-${randomUUID().slice(0, 8)}`]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert spec');
  CREATED_SPEC_IDS.push(id);
  return id;
}

describe('getSpecStyleSource', () => {
  it('returns null for a spec with no style source', async () => {
    const specId = await makeSpec();
    expect(await getSpecStyleSource(specId)).toBeNull();
  });

  it('returns null for a non-existent spec', async () => {
    expect(await getSpecStyleSource('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('returns { templateId, templateName } after assignment', async () => {
    const specId = await makeSpec();
    const templateId = await makeTemplate(`ss-get-${randomUUID().slice(0, 8)}`);
    await setSpecStyleSource(specId, templateId);

    const source = await getSpecStyleSource(specId);
    expect(source).toEqual({
      templateId,
      templateName: expect.stringContaining('ss-get-') as string,
    });
  });
});

describe('setSpecStyleSource', () => {
  it("returns 'spec-not-found' for a non-existent spec", async () => {
    const templateId = await makeTemplate(`ss-set-missing-spec-${randomUUID().slice(0, 8)}`);
    expect(await setSpecStyleSource('00000000-0000-0000-0000-000000000000', templateId)).toBe(
      'spec-not-found'
    );
  });

  it("assigns a built-in (library_id NULL) template to any spec ('assigned')", async () => {
    const specId = await makeSpec();
    const templateId = await makeTemplate(`ss-builtin-${randomUUID().slice(0, 8)}`);
    expect(await setSpecStyleSource(specId, templateId)).toBe('assigned');
  });

  it('re-assign replaces the previous template', async () => {
    const specId = await makeSpec();
    const first = await makeTemplate(`ss-replace-a-${randomUUID().slice(0, 8)}`);
    const second = await makeTemplate(`ss-replace-b-${randomUUID().slice(0, 8)}`);

    expect(await setSpecStyleSource(specId, first)).toBe('assigned');
    expect(await setSpecStyleSource(specId, second)).toBe('assigned');

    expect((await getSpecStyleSource(specId))?.templateId).toBe(second);
  });
});

describe('setSpecStyleSource — library scoping (#318)', () => {
  it("assigns a template owned by the spec's OWN library ('assigned')", async () => {
    const libId = await makeLibrary(`ss-scope-same-${randomUUID().slice(0, 8)}`);
    const specId = await makeSpecInLibrary(libId);
    const templateId = await makeScopedTemplate(`ss-same-lib-${randomUUID().slice(0, 8)}`, libId);

    expect(await setSpecStyleSource(specId, templateId)).toBe('assigned');
    expect((await getSpecStyleSource(specId))?.templateId).toBe(templateId);
  });

  it("rejects a template owned by a DIFFERENT library ('library-mismatch'), no write", async () => {
    const libA = await makeLibrary(`ss-scope-a-${randomUUID().slice(0, 8)}`);
    const libB = await makeLibrary(`ss-scope-b-${randomUUID().slice(0, 8)}`);
    const templateA = await makeScopedTemplate(`ss-lib-a-${randomUUID().slice(0, 8)}`, libA);
    const specB = await makeSpecInLibrary(libB);

    expect(await setSpecStyleSource(specB, templateA)).toBe('library-mismatch');
    // The rejected assignment did NOT write — the spec still has no style source.
    expect(await getSpecStyleSource(specB)).toBeNull();
  });

  it("allows a built-in (library_id NULL) template on a scoped-library spec ('assigned')", async () => {
    const libId = await makeLibrary(`ss-scope-builtin-${randomUUID().slice(0, 8)}`);
    const specId = await makeSpecInLibrary(libId);
    const builtIn = await makeTemplate(`ss-builtin-scope-${randomUUID().slice(0, 8)}`);

    expect(await setSpecStyleSource(specId, builtIn)).toBe('assigned');
  });
});

describe('clearSpecStyleSource', () => {
  it('clears an existing assignment', async () => {
    const specId = await makeSpec();
    const templateId = await makeTemplate(`ss-clear-${randomUUID().slice(0, 8)}`);
    await setSpecStyleSource(specId, templateId);

    expect(await clearSpecStyleSource(specId)).toBe(true);
    expect(await getSpecStyleSource(specId)).toBeNull();
  });

  it('is idempotent — clearing an already-null association returns true', async () => {
    const specId = await makeSpec();
    expect(await clearSpecStyleSource(specId)).toBe(true);
  });

  it('returns false for a non-existent spec', async () => {
    expect(await clearSpecStyleSource('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('countSpecsUsingTemplate', () => {
  it('counts specs referencing a template', async () => {
    const templateId = await makeTemplate(`ss-count-${randomUUID().slice(0, 8)}`);
    expect(await countSpecsUsingTemplate(templateId)).toBe(0);

    const specA = await makeSpec();
    const specB = await makeSpec();
    await setSpecStyleSource(specA, templateId);
    await setSpecStyleSource(specB, templateId);

    expect(await countSpecsUsingTemplate(templateId)).toBe(2);
  });
});
