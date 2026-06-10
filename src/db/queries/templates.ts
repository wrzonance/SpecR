import type { PoolClient } from 'pg';
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

type Queryable = Pick<PoolClient, 'query'>;

async function loadRules(
  templateId: string,
  client?: Queryable
): Promise<readonly StyleRule[]> {
  const q = client ?? pool;
  const result = await q.query<StyleRuleRow>(
    `SELECT node_type, properties
     FROM style_rules WHERE template_id = $1
     ORDER BY node_type`,
    [templateId]
  );
  return result.rows.map(mapRuleRow);
}

// Public so the bulk-rules transaction can read inside its client.
export async function selectTemplateMeta(
  id: string,
  client?: Queryable
): Promise<TemplateMeta | null> {
  const q = client ?? pool;
  const result = await q.query<TemplateRow>(
    `SELECT id, name, owner, created_at FROM style_templates WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row ? mapMetaRow(row) : null;
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

export async function createTemplateWithRules(
  name: string,
  owner: string | null,
  rules: readonly StyleRule[]
): Promise<Template> {
  // Parse up front so the stored and returned rules are the SAME validated values,
  // and so a validation throw never opens a transaction.
  const parsedRules = rules.map((r) => ({
    ...r,
    properties: StylePropertiesSchema.parse(r.properties),
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<TemplateRow>(
      `INSERT INTO style_templates (name, owner) VALUES ($1, $2)
       RETURNING id, name, owner, created_at`,
      [name, owner]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createTemplateWithRules: no row returned');
    for (const rule of parsedRules) {
      await client.query(
        `INSERT INTO style_rules (template_id, node_type, properties)
         VALUES ($1, $2, $3::jsonb)`,
        [row.id, rule.nodeType, JSON.stringify(rule.properties)]
      );
    }
    await client.query('COMMIT');
    return { ...mapMetaRow(row), rules: parsedRules };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection-level failure — original error wins */
    }
    // Unlike persistParsedSpec (which wraps unconditionally), internal DatabaseErrors
    // (e.g. the no-row sentinel) re-throw as-is — their specific message beats the
    // generic wrapper. Deliberate divergence.
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('failed to create template with rules', { cause: err });
  } finally {
    client.release();
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

interface TemplatePatch {
  readonly name?: string;
  readonly owner?: string | null;
}

export async function updateTemplateMeta(
  id: string,
  patch: TemplatePatch
): Promise<TemplateMeta | null> {
  // Build a dynamic SET clause from whichever fields are present.
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) {
    values.push(patch.name);
    fields.push(`name = $${values.length}`);
  }
  if ('owner' in patch) {
    values.push(patch.owner ?? null);
    fields.push(`owner = $${values.length}`);
  }
  if (fields.length === 0) {
    throw new DatabaseError('updateTemplateMeta: patch must contain at least one field');
  }
  values.push(id);
  const sql = `UPDATE style_templates SET ${fields.join(', ')}
               WHERE id = $${values.length}
               RETURNING id, name, owner, created_at`;
  try {
    const result = await pool.query<TemplateRow>(sql, values);
    const row = result.rows[0];
    return row ? mapMetaRow(row) : null;
  } catch (err) {
    throw new DatabaseError('failed to update template meta', { cause: err });
  }
}

export async function deleteTemplate(id: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `DELETE FROM style_templates WHERE id = $1`,
      [id]
    );
    return result.rowCount === 1;
  } catch (err) {
    throw new DatabaseError('failed to delete template', { cause: err });
  }
}

/**
 * Upsert all rules for a template inside the provided client transaction.
 * Validates ALL rules via StylePropertiesSchema BEFORE any insert so that
 * a single bad rule triggers a full rollback (caller's responsibility).
 */
export async function upsertStyleRulesBulk(
  templateId: string,
  rules: readonly StyleRule[],
  client: PoolClient
): Promise<void> {
  // Parse all first — a schema failure here throws before any DB writes.
  const parsed = rules.map((r) => ({
    nodeType: r.nodeType,
    properties: StylePropertiesSchema.parse(r.properties),
  }));
  for (const rule of parsed) {
    await client.query(
      `INSERT INTO style_rules (template_id, node_type, properties)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (template_id, node_type) DO UPDATE SET properties = EXCLUDED.properties`,
      [templateId, rule.nodeType, JSON.stringify(rule.properties)]
    );
  }
}

/**
 * Transactional bulk-rules endpoint helper: replaces all rules for a template
 * atomically. Returns the updated Template or null if template not found.
 */
export async function replaceTemplateRules(
  id: string,
  rules: readonly StyleRule[]
): Promise<Template | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row to prevent concurrent deletes racing this transaction.
    const lockResult = await client.query(
      `SELECT 1 FROM style_templates WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (lockResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    await upsertStyleRulesBulk(id, rules, client);
    const meta = await selectTemplateMeta(id, client);
    if (!meta) {
      await client.query('ROLLBACK');
      return null;
    }
    const updatedRules = await loadRules(id, client);
    await client.query('COMMIT');
    return { ...meta, rules: updatedRules };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection-level failure — original error wins */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('failed to replace template rules', { cause: err });
  } finally {
    client.release();
  }
}
