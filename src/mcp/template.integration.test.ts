import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool, setSpecStyleSource } from '../db/index.js';
import {
  handleListTemplates,
  handleGetTemplate,
  handleCreateTemplate,
  handleUpdateTemplate,
  handleUpsertTemplateRules,
  handleDeleteTemplate,
  handleImportTemplate,
} from './template-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-0000-0000-000000000000';
const DOCX_FIXTURE = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');

const createdTemplateIds: string[] = [];
const createdSpecIds: string[] = [];
const createdLibraryIds: string[] = [];

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}
function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function createTracked(name: string): Promise<string> {
  const res = await handleCreateTemplate({ name });
  const meta = parse<{ id: string }>(res);
  createdTemplateIds.push(meta.id);
  return meta.id;
}

afterAll(async () => {
  // Specs first (drops their style_source FK), then the templates they referenced.
  if (createdSpecIds.length > 0) {
    await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [createdSpecIds]);
  }
  if (createdTemplateIds.length > 0) {
    await pool.query('DELETE FROM style_templates WHERE id = ANY($1::uuid[])', [
      createdTemplateIds,
    ]);
  }
  if (createdLibraryIds.length > 0) {
    await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [createdLibraryIds]);
  }
});

describe('template MCP tools — CRUD lifecycle', () => {
  it('create → list → get → update → delete', async () => {
    const name = uniqueName('wave7a-tmpl');
    const id = await createTracked(name);

    const list = parse<{ id: string }[]>(await handleListTemplates());
    expect(list.some((t) => t.id === id)).toBe(true);

    const got = parse<{ id: string; name: string }>(await handleGetTemplate({ templateId: id }));
    expect(got.name).toBe(name);

    const renamed = uniqueName('wave7a-renamed');
    const updated = parse<{ name: string }>(
      await handleUpdateTemplate({ templateId: id, name: renamed })
    );
    expect(updated.name).toBe(renamed);

    const deleted = parse<{ deleted: boolean }>(await handleDeleteTemplate({ templateId: id }));
    expect(deleted.deleted).toBe(true);
    // gone now
    expect(isToolError(await handleGetTemplate({ templateId: id }))).toBe(true);
  });

  it('a duplicate template name is rejected', async () => {
    const name = uniqueName('wave7a-dup');
    await createTracked(name);
    expect(isToolError(await handleCreateTemplate({ name }))).toBe(true);
  });

  it('get / update / delete on a missing template are tool errors', async () => {
    expect(isToolError(await handleGetTemplate({ templateId: MISSING }))).toBe(true);
    expect(isToolError(await handleUpdateTemplate({ templateId: MISSING, name: 'x' }))).toBe(true);
    expect(isToolError(await handleDeleteTemplate({ templateId: MISSING }))).toBe(true);
  });

  it('update with no mutable field is rejected', async () => {
    const id = await createTracked(uniqueName('wave7a-noop'));
    expect(isToolError(await handleUpdateTemplate({ templateId: id }))).toBe(true);
  });
});

describe('template MCP tools — rules & import', () => {
  it('upsert_template_rules sets rules, get reflects them', async () => {
    const id = await createTracked(uniqueName('wave7a-rules'));
    const rules = [
      { nodeType: 'part', properties: { rPr: { b: true } } },
      { nodeType: 'article', properties: { rPr: { b: false } } },
    ];
    const upserted = parse<{ rules: { nodeType: string }[] }>(
      await handleUpsertTemplateRules({ templateId: id, rules })
    );
    const nodeTypes = upserted.rules.map((r) => r.nodeType);
    expect(nodeTypes).toContain('part');
    expect(nodeTypes).toContain('article');

    const got = parse<{ rules: { nodeType: string }[] }>(
      await handleGetTemplate({ templateId: id })
    );
    expect(got.rules.map((r) => r.nodeType).sort((a, b) => a.localeCompare(b))).toEqual([
      'article',
      'part',
    ]);
  });

  it('import_template derives a template from a .docx', async () => {
    const contentBase64 = readFileSync(DOCX_FIXTURE).toString('base64');
    const res = await handleImportTemplate({ name: uniqueName('wave7a-import'), contentBase64 });
    expect(isToolError(res)).toBe(false);
    const { template, report } = parse<{ template: { id: string }; report: unknown }>(res);
    createdTemplateIds.push(template.id);
    expect(template.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(report).toBeTruthy();
  });

  it('import_template rejects a non-base64 payload', async () => {
    const res = await handleImportTemplate({
      name: uniqueName('wave7a-bad'),
      contentBase64: 'not base64!!',
    });
    expect(isToolError(res)).toBe(true);
  });
});

describe('template MCP tools — delete guard', () => {
  it('delete_template is rejected while a spec references it (in_use)', async () => {
    const lib = await pool.query<{ id: string }>(
      `INSERT INTO libraries (tier, name) VALUES ('client', $1) RETURNING id`,
      [uniqueName('wave7a-lib')]
    );
    const libraryId = lib.rows[0]!.id;
    createdLibraryIds.push(libraryId);
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('27 21 00', 'Tmpl In-Use', 'ufgs', $1) RETURNING id`,
      [libraryId]
    );
    const specId = spec.rows[0]!.id;
    createdSpecIds.push(specId);

    const id = await createTracked(uniqueName('wave7a-inuse'));
    await setSpecStyleSource(specId, id);

    const res = await handleDeleteTemplate({ templateId: id });
    expect(isToolError(res)).toBe(true);
    expect(res.content[0]!.text.toLowerCase()).toContain('in use');
  });
});
