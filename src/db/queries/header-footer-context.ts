import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { resolveHeaderFooterConfig } from './header-footer.js';
import { findLibraryById } from './libraries.js';
import { parseSectionNumberFormat } from '../../lib/section-number.js';
import type { SectionNumberFormat } from '../../lib/section-number.js';
import type { HeaderFooterComposition } from '../../ast/index.js';

interface Queryable {
  query: Pool['query'];
}

interface SoleOwningProjectRow {
  readonly id: string;
  readonly name: string;
  readonly section_number_format: string;
}

/**
 * Header/footer identity-field facts sourced from the DB for a spec's
 * resolved generation context. No `date` here — date is generation-time,
 * not a DB fact; each consumer (src/api/generate-header-footer.ts,
 * src/mcp/handlers.ts) stamps it separately. `packageName`/`revisionName`/
 * `revisionLabel` are declared for shape parity with the generator's
 * `HeaderFooterFieldValues` but always resolve `undefined` on this
 * project-only-scope path — a bare `specId` has no verified, unambiguous
 * package/revision (#304).
 */
export interface HeaderFooterFieldSource {
  readonly packageName?: string;
  readonly revisionName?: string;
  readonly revisionLabel?: string;
  readonly projectName?: string;
  readonly projectNumber?: string;
  readonly clientName?: string;
  readonly clientNumber?: string;
}

export interface HeaderFooterGenerationContext {
  readonly composition: HeaderFooterComposition;
  readonly fieldValues: HeaderFooterFieldSource;
}

/**
 * Everything a single-spec DOCX generation derives from the spec's sole owning
 * project, resolved from ONE ownership snapshot (see `findSoleOwningProject`):
 *   - `sectionNumberFormat`: the project default to fall back to when the
 *     request omits a format (issue #267), or null when orphaned/ambiguous.
 *   - `headerFooter`: the resolved header/footer context (issue #304), or null
 *     when orphaned/ambiguous OR the owner has zero configured layers.
 * Both fields come from the same project row, so they can never mix settings
 * from two different projects under a concurrent membership change.
 */
export interface SpecGenerationContext {
  readonly sectionNumberFormat: SectionNumberFormat | null;
  readonly headerFooter: HeaderFooterGenerationContext | null;
}

/**
 * The one project that owns `specId` via `project_specs`, or null when the
 * spec is orphaned (zero projects) or ambiguously owned (two or more). This is
 * the single sole-ownership resolution for a spec's live generation context:
 * both the section-number-format fallback (issue #267) and the header/footer
 * config (issue #304) derive from THIS row, so they can never be read from two
 * different projects if a concurrent `project_specs` membership change lands
 * between them (the mixed-snapshot race). `section_number_format` rides along
 * so no second query has to re-resolve the owner.
 */
async function findSoleOwningProject(
  specId: string,
  db: Queryable
): Promise<SoleOwningProjectRow | null> {
  try {
    const { rows } = await db.query<SoleOwningProjectRow>(
      `SELECT DISTINCT p.id, p.name, p.section_number_format
       FROM projects p
       JOIN project_specs ps ON ps.project_id = p.id
       WHERE ps.spec_id = $1 AND p.deleted_at IS NULL`,
      [specId]
    );
    const row = rows[0];
    return rows.length === 1 && row ? row : null;
  } catch (err) {
    throw new DatabaseError(`findSoleOwningProject: query failed for spec ${specId}`, {
      cause: err,
    });
  }
}

/**
 * Resolve a client library's display name for header/footer field values. A
 * null id (no client source in the project's chain), or an id that no
 * longer resolves (`findLibraryById` returns null on not-found), both fall
 * through to `undefined` rather than throwing — only a genuine query
 * failure propagates, as the `DatabaseError` `findLibraryById` already
 * throws (never swallowed).
 */
async function resolveClientName(
  clientLibraryId: string | null,
  db: Queryable
): Promise<string | undefined> {
  if (!clientLibraryId) return undefined;
  const library = await findLibraryById(clientLibraryId, db);
  return library?.name;
}

/**
 * Build the header/footer generation context for an already-resolved sole
 * owning project, or null when that project has zero configured header/footer
 * layers anywhere in its client→project chain (`resolveHeaderFooterConfig`
 * always returns a non-null `{ config: {} }` even with zero rows —
 * `layers.length` is the only real "configured" signal).
 *
 * Never invents package/revision-level context: no verified schema gives a
 * bare `specId` an unambiguous package/revision, so
 * `HeaderFooterFieldSource.packageName`/`revisionName`/`revisionLabel` stay
 * permanently undefined on this path.
 */
async function buildHeaderFooterFromProject(
  project: SoleOwningProjectRow,
  db: Queryable
): Promise<HeaderFooterGenerationContext | null> {
  const resolved = await resolveHeaderFooterConfig({ projectId: project.id }, db);
  if (!resolved || resolved.layers.length === 0) return null;

  const clientName = await resolveClientName(resolved.context.clientLibraryId, db);
  const fieldValues: HeaderFooterFieldSource = {
    projectName: project.name,
    ...(clientName !== undefined ? { clientName } : {}),
  };

  return { composition: resolved.config, fieldValues };
}

/**
 * Resolve everything a spec's live, single-spec DOCX generation derives from
 * its sole owning project — the section-number-format fallback AND the
 * header/footer context — from ONE ownership snapshot. Resolving the owner
 * once is what prevents a mixed-project snapshot: a concurrent `project_specs`
 * membership change can no longer wedge between two independent lookups and
 * pair one project's numbering with another's header/footer. When the spec is
 * orphaned or ambiguously owned, both fields are null and generation falls back
 * to its byte-identical, pre-#267/#304 baseline.
 *
 * Propagates `DatabaseError` (and its `HeaderFooterValidationError` subclass)
 * unchanged — never swallowed.
 */
export async function resolveSpecGenerationContext(
  specId: string,
  db: Queryable = pool
): Promise<SpecGenerationContext> {
  const project = await findSoleOwningProject(specId, db);
  if (!project) return { sectionNumberFormat: null, headerFooter: null };

  const headerFooter = await buildHeaderFooterFromProject(project, db);
  return {
    sectionNumberFormat: parseSectionNumberFormat(project.section_number_format),
    headerFooter,
  };
}

/**
 * Header/footer-only view of `resolveSpecGenerationContext` for callers that
 * do not resolve a section-number format (the MCP `generate_docx` path). Null
 * when the spec is orphaned/ambiguously owned or the owner has zero configured
 * layers — the one gate that keeps `generateDocx`'s output byte-identical to
 * the pre-#304 baseline.
 */
export async function resolveSpecHeaderFooterContext(
  specId: string,
  db: Queryable = pool
): Promise<HeaderFooterGenerationContext | null> {
  return (await resolveSpecGenerationContext(specId, db)).headerFooter;
}
