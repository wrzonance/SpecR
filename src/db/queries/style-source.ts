import { pool, DatabaseError } from '../index.js';

// Issue #138 (O-12) — the spec ↔ style-template association (manual pick).
// Kept deliberately disjoint from getSpecTree (db/queries/specs.ts, owned by a
// parallel PR): the API handler merges this in as a sibling field rather than
// threading it through the tree query.

export interface SpecStyleSource {
  readonly templateId: string;
  readonly templateName: string;
}

interface StyleSourceRow {
  readonly style_template_id: string | null;
  readonly template_name: string | null;
}

/**
 * Resolve a spec's assigned style template, or null when it has none (or the
 * spec is absent — the API layer 404s on a missing spec before reaching here).
 */
export async function getSpecStyleSource(specId: string): Promise<SpecStyleSource | null> {
  try {
    const result = await pool.query<StyleSourceRow>(
      `SELECT s.style_template_id, t.name AS template_name
       FROM specs s
       LEFT JOIN style_templates t ON t.id = s.style_template_id
       WHERE s.id = $1`,
      [specId]
    );
    const row = result.rows[0];
    if (!row || row.style_template_id === null || row.template_name === null) return null;
    return { templateId: row.style_template_id, templateName: row.template_name };
  } catch (err) {
    throw new DatabaseError('failed to get spec style source', { cause: err });
  }
}

/**
 * Assign (or replace) the spec's style template. Returns false when the spec
 * does not exist; FK violations (unknown template) surface as DatabaseError —
 * the caller pre-checks template existence to return the right 404.
 */
export async function setSpecStyleSource(specId: string, templateId: string): Promise<boolean> {
  try {
    const result = await pool.query(`UPDATE specs SET style_template_id = $2 WHERE id = $1`, [
      specId,
      templateId,
    ]);
    return (result.rowCount ?? 0) === 1;
  } catch (err) {
    throw new DatabaseError('failed to set spec style source', { cause: err });
  }
}

/**
 * Clear the spec's style template (idempotent). Returns false when the spec
 * does not exist; clearing an already-null association still returns true.
 */
export async function clearSpecStyleSource(specId: string): Promise<boolean> {
  try {
    const result = await pool.query(`UPDATE specs SET style_template_id = NULL WHERE id = $1`, [
      specId,
    ]);
    return (result.rowCount ?? 0) === 1;
  } catch (err) {
    throw new DatabaseError('failed to clear spec style source', { cause: err });
  }
}

/**
 * Count specs referencing a template — feeds the RESTRICT 409 message on a
 * delete-while-referenced attempt (the delete path pre-checks this instead of
 * routing the ambiguous pg 23503 through the generic mapper).
 */
export async function countSpecsUsingTemplate(templateId: string): Promise<number> {
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM specs WHERE style_template_id = $1`,
      [templateId]
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch (err) {
    throw new DatabaseError('failed to count specs using template', { cause: err });
  }
}
