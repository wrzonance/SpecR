import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  getTemplate,
  getTemplateByName,
  listTemplates,
  createTemplate,
  upsertStyleRule,
  type StyleRule,
} from './templates.js';

const CREATED_TEMPLATE_NAMES: string[] = [];

afterEach(async () => {
  if (CREATED_TEMPLATE_NAMES.length === 0) return;
  await pool.query(`DELETE FROM style_templates WHERE name = ANY($1::text[])`, [
    CREATED_TEMPLATE_NAMES,
  ]);
  CREATED_TEMPLATE_NAMES.length = 0;
});

function trackName(name: string): string {
  CREATED_TEMPLATE_NAMES.push(name);
  return name;
}

describe('getTemplateByName — UFGS-Default seed', () => {
  it('returns the seeded UFGS-Default template', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    expect(tpl).not.toBeNull();
    expect(tpl!.name).toBe('UFGS-Default');
    expect(tpl!.owner).toBeNull();
  });

  it('contains exactly 7 style rules (one per NodeType)', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    expect(tpl!.rules).toHaveLength(7);
  });

  it('contains each NodeType exactly once', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    const types = tpl!.rules.map((r) => r.nodeType).sort((a, b) => a.localeCompare(b));
    expect(types).toEqual(['article', 'part', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5']);
  });

  it('part rule has correct UFGS-extracted values', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    const part = tpl!.rules.find((r) => r.nodeType === 'part');
    expect(part).toBeDefined();
    expect(part!.fontFamily).toBe('Courier New');
    expect(part!.fontSizeHalfPt).toBe(20);
    expect(part!.bold).toBe(true);
    expect(part!.caps).toBe(true);
    expect(part!.numberingFormat).toBe('PART %1 -');
  });
});

describe('getTemplate', () => {
  it('returns null for unknown UUID', async () => {
    const result = await getTemplate('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('loads template + rules by id', async () => {
    const byName = await getTemplateByName('UFGS-Default');
    const byId = await getTemplate(byName!.id);
    expect(byId).not.toBeNull();
    expect(byId!.id).toBe(byName!.id);
    expect(byId!.rules).toHaveLength(7);
  });
});

describe('listTemplates', () => {
  it('includes UFGS-Default in metadata list', async () => {
    const list = await listTemplates();
    const names = list.map((t) => t.name);
    expect(names).toContain('UFGS-Default');
  });
});

describe('createTemplate', () => {
  it('creates a new template row with given name + owner', async () => {
    const name = trackName(`test-firm-${Date.now()}`);
    const meta = await createTemplate(name, 'Acme');
    expect(meta.name).toBe(name);
    expect(meta.owner).toBe('Acme');
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('defaults owner to null when omitted', async () => {
    const name = trackName(`test-noowner-${Date.now()}`);
    const meta = await createTemplate(name);
    expect(meta.owner).toBeNull();
  });
});

describe('upsertStyleRule', () => {
  function ruleFor(nodeType: string, indent: number): StyleRule {
    return {
      nodeType,
      fontFamily: 'Arial',
      fontSizeHalfPt: 24,
      bold: false,
      caps: false,
      indentTwips: indent,
      spaceBeforeTwips: null,
      spaceAfterTwips: null,
      numberingFormat: null,
    };
  }

  it('inserts on first call, updates on second call (idempotent)', async () => {
    const name = trackName(`upsert-test-${Date.now()}`);
    const meta = await createTemplate(name);

    await upsertStyleRule(meta.id, ruleFor('pr1', 720));
    const first = await getTemplate(meta.id);
    expect(first!.rules).toHaveLength(1);
    expect(first!.rules[0]!.indentTwips).toBe(720);

    await upsertStyleRule(meta.id, ruleFor('pr1', 1440));
    const second = await getTemplate(meta.id);
    expect(second!.rules).toHaveLength(1); // still one row
    expect(second!.rules[0]!.indentTwips).toBe(1440); // updated
  });
});

describe('FK cascade behavior', () => {
  it('deleting a template cascades to its style_rules rows', async () => {
    const name = trackName(`cascade-test-${Date.now()}`);
    const meta = await createTemplate(name);
    await upsertStyleRule(meta.id, {
      nodeType: 'pr1',
      fontFamily: null,
      fontSizeHalfPt: null,
      bold: false,
      caps: false,
      indentTwips: null,
      spaceBeforeTwips: null,
      spaceAfterTwips: null,
      numberingFormat: null,
    });

    const before = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM style_rules WHERE template_id = $1',
      [meta.id]
    );
    expect(Number(before.rows[0]!.count)).toBe(1);

    await pool.query('DELETE FROM style_templates WHERE id = $1', [meta.id]);

    const after = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM style_rules WHERE template_id = $1',
      [meta.id]
    );
    expect(Number(after.rows[0]!.count)).toBe(0);

    // Don't keep this in the afterEach delete list — already gone.
    const idx = CREATED_TEMPLATE_NAMES.indexOf(name);
    if (idx >= 0) CREATED_TEMPLATE_NAMES.splice(idx, 1);
  });
});

describe('UNIQUE constraint on template name', () => {
  it('rejects creating two templates with the same name', async () => {
    const name = trackName(`unique-test-${Date.now()}`);
    await createTemplate(name);
    await expect(createTemplate(name)).rejects.toThrow();
  });
});
