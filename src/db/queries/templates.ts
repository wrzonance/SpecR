import { pool, DatabaseError } from '../index.js';
import type { StyleNodeType, StyleProperties } from '../../ast/types.js';
import { STYLE_NODE_TYPES } from '../../ast/types.js';
import { StylePropertiesSchema } from '../../ast/index.js';

// Re-export the relocated symbols (local bindings) so existing importers
// (db/index.ts barrel, integration tests) keep resolving them from this module.
export type { StyleNodeType, StyleProperties };
export { STYLE_NODE_TYPES };

export interface StyleRule {
  readonly nodeType: StyleNodeType;
  readonly properties: StyleProperties;
}

export interface TemplateMeta {
  readonly id: string;
  readonly name: string;
  readonly owner: string | null;
  readonly createdAt: Date;
}

export interface Template extends TemplateMeta {
  readonly rules: readonly StyleRule[];
}

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly owner: string | null;
  readonly created_at: Date;
}

interface StyleRuleRow {
  readonly node_type: StyleNodeType;
  // pg returns jsonb as an unknown JS value — validated in mapRuleRow, never trusted.
  readonly properties: unknown;
}

function mapRuleRow(row: StyleRuleRow): StyleRule {
  // Validate the jsonb at the DB boundary: the open schema preserves unknown OOXML
  // keys but enforces the StyleProperties contract on the keys we understand.
  return { nodeType: row.node_type, properties: StylePropertiesSchema.parse(row.properties) };
}

function mapMetaRow(row: TemplateRow): TemplateMeta {
  return { id: row.id, name: row.name, owner: row.owner, createdAt: row.created_at };
}

async function loadRules(templateId: string): Promise<readonly StyleRule[]> {
  const result = await pool.query<StyleRuleRow>(
    `SELECT node_type, properties
     FROM style_rules WHERE template_id = $1
     ORDER BY node_type`,
    [templateId]
  );
  return result.rows.map(mapRuleRow);
}

export async function getTemplate(id: string): Promise<Template | null> {
  try {
    const result = await pool.query<TemplateRow>(
      `SELECT id, name, owner, created_at FROM style_templates WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    const rules = await loadRules(row.id);
    return { ...mapMetaRow(row), rules };
  } catch (err) {
    throw new DatabaseError('failed to get template by id', { cause: err });
  }
}

export async function getTemplateByName(name: string): Promise<Template | null> {
  try {
    const result = await pool.query<TemplateRow>(
      `SELECT id, name, owner, created_at FROM style_templates WHERE name = $1`,
      [name]
    );
    const row = result.rows[0];
    if (!row) return null;
    const rules = await loadRules(row.id);
    return { ...mapMetaRow(row), rules };
  } catch (err) {
    throw new DatabaseError('failed to get template by name', { cause: err });
  }
}

export async function listTemplates(): Promise<readonly TemplateMeta[]> {
  try {
    const result = await pool.query<TemplateRow>(
      `SELECT id, name, owner, created_at FROM style_templates ORDER BY name`
    );
    return result.rows.map(mapMetaRow);
  } catch (err) {
    throw new DatabaseError('failed to list templates', { cause: err });
  }
}

export async function createTemplate(name: string, owner?: string): Promise<TemplateMeta> {
  try {
    const result = await pool.query<TemplateRow>(
      `INSERT INTO style_templates (name, owner) VALUES ($1, $2)
       RETURNING id, name, owner, created_at`,
      [name, owner ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createTemplate: no row returned');
    return mapMetaRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('failed to create template', { cause: err });
  }
}

export async function upsertStyleRule(templateId: string, rule: StyleRule): Promise<void> {
  try {
    // Validate at the boundary, then serialize + cast explicitly (matches revit.ts):
    // pass JSON text into $3::jsonb.
    await pool.query(
      `INSERT INTO style_rules (template_id, node_type, properties)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (template_id, node_type) DO UPDATE SET properties = EXCLUDED.properties`,
      [templateId, rule.nodeType, JSON.stringify(StylePropertiesSchema.parse(rule.properties))]
    );
  } catch (err) {
    throw new DatabaseError('failed to upsert style rule', { cause: err });
  }
}
