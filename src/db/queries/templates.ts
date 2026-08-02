import type { Pool, PoolClient } from 'pg';
import { pool, DatabaseError, countSpecsUsingTemplate } from '../index.js';
import { isRestrictedDeleteViolation } from '../../lib/pg-errors.js';
import type { StyleNodeType, StyleProperties, StyleRule } from '../../ast/types.js';
import { STYLE_NODE_TYPES } from '../../ast/types.js';
import { StylePropertiesSchema } from '../../ast/index.js';

// Re-export the relocated symbols (local bindings) so existing importers
// (db/index.ts barrel, integration tests) keep resolving them from this module.
export type { StyleNodeType, StyleProperties, StyleRule };
export { STYLE_NODE_TYPES };

export interface TemplateMeta {
  readonly id: string;
  readonly name: string;
  readonly owner: string | null;
  // ADR-051 / #318 — library scope: NULL = built-in / global default.
  readonly libraryId: string | null;
  readonly createdAt: Date;
}

export interface Template extends TemplateMeta {
  readonly rules: readonly StyleRule[];
}

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly owner: string | null;
  readonly library_id: string | null;
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
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    libraryId: row.library_id,
    createdAt: row.created_at,
  };
}

// Shared SELECT list — keep every read exposing library_id (#318) in lockstep.
const META_COLUMNS = 'id, name, owner, library_id, created_at';

interface Queryable {
  query: Pool['query'];
}

async function loadRules(templateId: string, client?: Queryable): Promise<readonly StyleRule[]> {
  const q = client ?? pool;
  const result = await q.query<StyleRuleRow>(
    `SELECT node_type, properties
     FROM style_rules WHERE template_id = $1
     ORDER BY node_type`,
    [templateId]
  );
  return result.rows.map(mapRuleRow);
}

// Internal: the bulk-rules transaction reads meta inside its own client.
async function selectTemplateMeta(id: string, client?: Queryable): Promise<TemplateMeta | null> {
  const q = client ?? pool;
  const result = await q.query<TemplateRow>(
    `SELECT ${META_COLUMNS} FROM style_templates WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row ? mapMetaRow(row) : null;
}

export async function getTemplate(id: string): Promise<Template | null> {
  try {
    const result = await pool.query<TemplateRow>(
      `SELECT ${META_COLUMNS} FROM style_templates WHERE id = $1`,
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
      `SELECT ${META_COLUMNS} FROM style_templates WHERE name = $1`,
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
      `SELECT ${META_COLUMNS} FROM style_templates ORDER BY name`
    );
    return result.rows.map(mapMetaRow);
  } catch (err) {
    throw new DatabaseError('failed to list templates', { cause: err });
  }
}

export async function createTemplate(
  name: string,
  owner?: string,
  // #318 — NULL (default) = built-in / global template; a library UUID scopes it.
  libraryId?: string | null
): Promise<TemplateMeta> {
  try {
    const result = await pool.query<TemplateRow>(
      `INSERT INTO style_templates (name, owner, library_id) VALUES ($1, $2, $3)
       RETURNING ${META_COLUMNS}`,
      [name, owner ?? null, libraryId ?? null]
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
  rules: readonly StyleRule[],
  // #318 — NULL (default) = built-in / global template; a library UUID scopes it
  // (onboarding passes the spec's library so its template is not a global built-in).
  libraryId: string | null = null
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
      `INSERT INTO style_templates (name, owner, library_id) VALUES ($1, $2, $3)
       RETURNING ${META_COLUMNS}`,
      [name, owner, libraryId]
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
  // `| undefined` matches the Zod-inferred PatchTemplateBody (.nullable().optional()).
  // JSON can never carry an explicit undefined; key-present-undefined is unreachable.
  readonly owner?: string | null | undefined;
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
               RETURNING ${META_COLUMNS}`;
  try {
    const result = await pool.query<TemplateRow>(sql, values);
    const row = result.rows[0];
    return row ? mapMetaRow(row) : null;
  } catch (err) {
    throw new DatabaseError('failed to update template meta', { cause: err });
  }
}

// Discriminated outcome so the handler maps each case to the right status:
// not_found → 404, in_use → 409 (RESTRICT enforcement), deleted → 204.
export type DeleteTemplateResult =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly reason: 'not_found' | 'in_use'; readonly inUseBy?: number };

/**
 * Delete a template, enforcing the ON DELETE RESTRICT contract via an explicit
 * reference-count pre-check (issue #138). A template referenced by any spec is
 * NOT deletable — the pre-check yields a clear 409 message and sidesteps the
 * ambiguity of the raw FK code (on Postgres <=16 the same 23503 means 404 on
 * assign, 409 on delete; Postgres 18 splits the delete case out as 23001).
 */
export async function deleteTemplate(id: string): Promise<DeleteTemplateResult> {
  try {
    const inUseBy = await countSpecsUsingTemplate(id);
    if (inUseBy > 0) return { deleted: false, reason: 'in_use', inUseBy };
    const result = await pool.query(`DELETE FROM style_templates WHERE id = $1`, [id]);
    if ((result.rowCount ?? 0) === 1) return { deleted: true };
    return { deleted: false, reason: 'not_found' };
  } catch (err) {
    const dbErr =
      err instanceof DatabaseError
        ? err
        : new DatabaseError('failed to delete template', { cause: err });
    // RESTRICT race: a spec assigned to this template between the pre-check and
    // the DELETE makes Postgres reject the delete with a RESTRICT FK violation —
    // the authoritative in_use signal (23503 on Postgres <=16, 23001 on Postgres
    // 18 — see isRestrictedDeleteViolation). (A SELECT … FOR UPDATE on the
    // template row would NOT close this: the concurrent assign UPDATEs `specs`,
    // not the locked row.) Re-count for the message.
    if (isRestrictedDeleteViolation(dbErr)) {
      const inUseBy = await countSpecsUsingTemplate(id);
      return { deleted: false, reason: 'in_use', inUseBy };
    }
    throw dbErr;
  }
}

/**
 * Internal: upsert the submitted rules inside the provided client transaction.
 * Validates ALL rules' properties via StylePropertiesSchema BEFORE any insert
 * so that a schema failure never leaves partial writes (caller rolls back on
 * any throw, including mid-batch DB constraint violations).
 */
async function upsertStyleRulesBulk(
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
 * Transactional bulk-rules endpoint helper: UPSERTS the submitted NodeTypes
 * atomically — existing rules for NodeTypes absent from `rules` are left
 * untouched (re-running the same bulk upsert updates, never duplicates).
 * All-or-nothing: one bad rule rolls back every write in the batch.
 * Returns the updated Template or null if the template does not exist.
 */
export async function bulkUpsertTemplateRules(
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
    if ((lockResult.rowCount ?? 0) === 0) {
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
    throw new DatabaseError('failed to bulk upsert template rules', { cause: err });
  } finally {
    client.release();
  }
}
