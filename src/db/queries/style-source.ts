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

/** Outcome of assigning a style template to a spec (library scoping enforced, #318). */
export type SetSpecStyleResult =
  'assigned' | 'spec-not-found' | 'template-not-found' | 'library-mismatch';

/**
 * Assign (or replace) the spec's style template, enforcing library scoping (#318,
 * mirrors setSpecNumberingProfile): a spec may be assigned only a built-in / global
 * template (library_id IS NULL) or one owned by its OWN library. The scope predicate
 * lives in the UPDATE's WHERE so a cross-library assignment matches zero rows
 * atomically — otherwise a library-A template could bind a library-B spec, hiding
 * it from B's scoped view and blocking A's deletion via the RESTRICT FK.
 *
 * A PROJECT spec has library_id NULL (specs_owner_xor constraint), so the predicate
 * admits only built-in templates for it — identical to the numbering precedent; no
 * separate project-spec policy is invented.
 *
 * The handler pre-checks that the template exists; a template deleted in the window
 * between that pre-check and this UPDATE yields 'template-not-found' (→404), NOT
 * 'library-mismatch' — the EXISTS predicate matches zero rows instead of throwing
 * a 23503, so the disambiguation must check the template too, not only the spec (#366).
 */
export async function setSpecStyleSource(
  specId: string,
  templateId: string
): Promise<SetSpecStyleResult> {
  try {
    const upd = await pool.query(
      `UPDATE specs s
          SET style_template_id = $2
        WHERE s.id = $1
          AND EXISTS (
            SELECT 1 FROM style_templates t
            WHERE t.id = $2 AND (t.library_id IS NULL OR t.library_id = s.library_id)
          )`,
      [specId, templateId]
    );
    if ((upd.rowCount ?? 0) === 1) return 'assigned';
    // No row updated — disambiguate in precedence order so the handler maps each
    // cleanly: a missing spec (→404) first, then a template that vanished after the
    // pre-check (→404, #366), else a genuine cross-library scope rejection (→409).
    const specExists = await pool.query(`SELECT 1 FROM specs WHERE id = $1`, [specId]);
    if ((specExists.rowCount ?? 0) === 0) return 'spec-not-found';
    const templateExists = await pool.query(`SELECT 1 FROM style_templates WHERE id = $1`, [
      templateId,
    ]);
    return (templateExists.rowCount ?? 0) === 1 ? 'library-mismatch' : 'template-not-found';
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
