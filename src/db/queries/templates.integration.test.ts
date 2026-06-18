import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  getTemplate,
  getTemplateByName,
  listTemplates,
  createTemplate,
  upsertStyleRule,
  createTemplateWithRules,
  type StyleNodeType,
  type StyleRule,
} from './templates.js';
import { StylePropertiesSchema } from '../../ast/index.js';

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

  it('contains exactly 9 style rules (one per styleable NodeType)', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    expect(tpl!.rules).toHaveLength(9);
  });

  it('contains each NodeType exactly once', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    const types = tpl!.rules.map((r) => r.nodeType).sort((a, b) => a.localeCompare(b));
    expect(types).toEqual(['article', 'part', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7']);
  });

  it('part rule carries UFGS-extracted values in the JSONB payload', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    const part = tpl!.rules.find((r) => r.nodeType === 'part');
    expect(part).toBeDefined();
    expect(part!.properties.rPr?.rFonts?.ascii).toBe('Courier New');
    expect(part!.properties.rPr?.sz).toBe(20);
    expect(part!.properties.rPr?.b).toBe(true);
    expect(part!.properties.rPr?.caps).toBe(true);
    expect(part!.properties.numbering?.lvlText).toBe('PART %1 -');
  });

  it('migration 014 enriched UFGS-Default pr1 with the previously-lost line spacing', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    const pr1 = tpl!.rules.find((r) => r.nodeType === 'pr1');
    expect(pr1!.properties.pPr?.spacing?.line).toBe(360);
    expect(pr1!.properties.pPr?.spacing?.lineRule).toBe('auto');
    expect(pr1!.properties.numbering?.numFmt).toBe('upperLetter');
    expect(pr1!.properties.pPr?.ind?.left).toBe(720);
  });

  it('article rule has no empty ind object after backfill (NULLIF tidy)', async () => {
    const tpl = await getTemplateByName('UFGS-Default');
    const article = tpl!.rules.find((r) => r.nodeType === 'article');
    expect(article!.properties.pPr?.ind).toBeUndefined();
    expect(article!.properties.rPr?.rFonts?.ascii).toBe('Courier New');
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
    expect(byId!.rules).toHaveLength(9);
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
  function ruleFor(nodeType: StyleNodeType, indent: number): StyleRule {
    return { nodeType, properties: { pPr: { ind: { left: indent } } } };
  }

  it('inserts on first call, updates on second call (idempotent)', async () => {
    const name = trackName(`upsert-test-${Date.now()}`);
    const meta = await createTemplate(name);

    await upsertStyleRule(meta.id, ruleFor('pr1', 720));
    const first = await getTemplate(meta.id);
    expect(first!.rules).toHaveLength(1);
    expect(first!.rules[0]!.properties.pPr?.ind?.left).toBe(720);

    await upsertStyleRule(meta.id, ruleFor('pr1', 1440));
    const second = await getTemplate(meta.id);
    expect(second!.rules).toHaveLength(1); // still one row
    expect(second!.rules[0]!.properties.pPr?.ind?.left).toBe(1440); // updated
  });

  it('round-trips an UNKNOWN OOXML property through jsonb (footgun closed)', async () => {
    const name = trackName(`footgun-test-${Date.now()}`);
    const meta = await createTemplate(name);
    // Build via the schema so `properties` has exactly the inferred type and so this
    // also proves a schema-validated payload (incl. its unknown key) survives the DB.
    const properties = StylePropertiesSchema.parse({
      rPr: { rFonts: { ascii: 'Arial' }, sz: 24, i: true },
      pPr: { spacing: { line: 360, lineRule: 'auto' }, ind: { left: 720, hanging: 360 } },
      numbering: { ilvl: 2, numFmt: 'upperLetter', lvlText: '%3.' },
      pBdrUnknown: { top: 'single' }, // not modelled — must survive
    });
    await upsertStyleRule(meta.id, { nodeType: 'pr1', properties });
    const loaded = await getTemplate(meta.id);
    const rule = loaded!.rules.find((r) => r.nodeType === 'pr1');
    expect(rule!.properties).toEqual(properties);
  });
});

describe('FK cascade behavior', () => {
  it('deleting a template cascades to its style_rules rows', async () => {
    const name = trackName(`cascade-test-${Date.now()}`);
    const meta = await createTemplate(name);
    await upsertStyleRule(meta.id, { nodeType: 'pr1', properties: {} });

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

describe('createTemplateWithRules', () => {
  function ruleFor(nodeType: StyleNodeType, indent: number): StyleRule {
    return {
      nodeType,
      properties: StylePropertiesSchema.parse({ pPr: { ind: { left: indent } } }),
    };
  }

  it('atomic create: returns Template with both rules; getTemplate confirms persistence', async () => {
    const name = trackName(`atomic-create-${Date.now()}`);
    const ruleA = ruleFor('pr1', 720);
    const ruleB = ruleFor('pr2', 1440);
    const tpl = await createTemplateWithRules(name, 'test-owner', [ruleA, ruleB]);

    expect(tpl.name).toBe(name);
    expect(tpl.owner).toBe('test-owner');
    expect(tpl.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tpl.rules).toHaveLength(2);
    const nodeTypes = tpl.rules.map((r) => r.nodeType).sort((a, b) => a.localeCompare(b));
    expect(nodeTypes).toEqual(['pr1', 'pr2']);

    const loaded = await getTemplate(tpl.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.owner).toBe('test-owner');
    const pr1 = loaded!.rules.find((r) => r.nodeType === 'pr1');
    const pr2 = loaded!.rules.find((r) => r.nodeType === 'pr2');
    expect(pr1!.properties.pPr?.ind?.left).toBe(720);
    expect(pr2!.properties.pPr?.ind?.left).toBe(1440);
  });

  it('duplicate name: rejects; no orphan style_rules beyond the first template', async () => {
    const name = trackName(`dup-name-${Date.now()}`);
    const rule = ruleFor('pr1', 720);
    await createTemplateWithRules(name, null, [rule]);

    await expect(createTemplateWithRules(name, null, [rule])).rejects.toThrow();

    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM style_rules sr
       JOIN style_templates st ON st.id = sr.template_id
       WHERE st.name = $1`,
      [name]
    );
    expect(Number(result.rows[0]!.count)).toBe(1);
  });

  it('all-or-nothing rollback: invalid node_type rejects and template row is absent', async () => {
    const name = trackName(`rollback-${Date.now()}`);
    const validRule = ruleFor('pr1', 720);
    const badRule = { nodeType: 'bogus' as StyleNodeType, properties: {} };

    await expect(createTemplateWithRules(name, null, [validRule, badRule])).rejects.toThrow();

    const rolled = await getTemplateByName(name);
    expect(rolled).toBeNull();
  });
});
