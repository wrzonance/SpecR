import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { randomUUID } from 'node:crypto';
import {
  getSpecStyleSource,
  setSpecStyleSource,
  clearSpecStyleSource,
  countSpecsUsingTemplate,
} from './style-source.js';

const CREATED_TEMPLATE_NAMES: string[] = [];
const CREATED_SPEC_IDS: string[] = [];

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
});

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
    const templateId = await makeTemplate(`ss-get-${Date.now()}`);
    await setSpecStyleSource(specId, templateId);

    const source = await getSpecStyleSource(specId);
    expect(source).toEqual({
      templateId,
      templateName: expect.stringContaining('ss-get-') as string,
    });
  });
});

describe('setSpecStyleSource', () => {
  it('returns false for a non-existent spec', async () => {
    const templateId = await makeTemplate(`ss-set-missing-spec-${Date.now()}`);
    expect(await setSpecStyleSource('00000000-0000-0000-0000-000000000000', templateId)).toBe(
      false
    );
  });

  it('re-assign replaces the previous template', async () => {
    const specId = await makeSpec();
    const first = await makeTemplate(`ss-replace-a-${Date.now()}`);
    const second = await makeTemplate(`ss-replace-b-${Date.now()}`);

    await setSpecStyleSource(specId, first);
    await setSpecStyleSource(specId, second);

    expect((await getSpecStyleSource(specId))?.templateId).toBe(second);
  });
});

describe('clearSpecStyleSource', () => {
  it('clears an existing assignment', async () => {
    const specId = await makeSpec();
    const templateId = await makeTemplate(`ss-clear-${Date.now()}`);
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
    const templateId = await makeTemplate(`ss-count-${Date.now()}`);
    expect(await countSpecsUsingTemplate(templateId)).toBe(0);

    const specA = await makeSpec();
    const specB = await makeSpec();
    await setSpecStyleSource(specA, templateId);
    await setSpecStyleSource(specB, templateId);

    expect(await countSpecsUsingTemplate(templateId)).toBe(2);
  });
});
