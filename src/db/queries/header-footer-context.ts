import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { resolveHeaderFooterConfig } from './header-footer.js';
import { findLibraryById } from './libraries.js';
import type { HeaderFooterComposition } from '../../ast/index.js';

interface Queryable {
  query: Pool['query'];
}

interface SoleOwningProjectRow {
  readonly id: string;
  readonly name: string;
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
 * The one project that owns `specId` via `project_specs`, or null when the
 * spec is orphaned (zero projects) or ambiguously owned (two or more) — the
 * same sole-ownership rule as `findSoleProjectSectionNumberFormat`
 * (src/db/queries/projects.ts), mirrored here rather than shared: that file
 * is already at its 400-line ESLint cap, so a small duplicated query is the
 * deliberate, cheaper cost of respecting the file-budget rule (#304).
 */
async function findSoleOwningProject(
  specId: string,
  db: Queryable
): Promise<SoleOwningProjectRow | null> {
  try {
    const { rows } = await db.query<SoleOwningProjectRow>(
      `SELECT DISTINCT p.id, p.name
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
 * Resolve the effective header/footer generation context for a spec's live,
 * single-spec DOCX generation — or null when nothing applies:
 *   - the spec is orphaned or ambiguously owned (see `findSoleOwningProject`)
 *   - the resolvable project has zero configured header/footer layers
 *     anywhere in its client→project chain (`resolveHeaderFooterConfig`
 *     always returns a non-null `{ config: {} }` even with zero rows —
 *     `layers.length` is the only real "configured" signal).
 *
 * Never invents package/revision-level context: no verified schema gives a
 * bare `specId` an unambiguous package/revision, so
 * `HeaderFooterFieldSource.packageName`/`revisionName`/`revisionLabel` stay
 * permanently undefined on this path.
 *
 * Propagates `DatabaseError` (and its `HeaderFooterValidationError`
 * subclass) unchanged — never swallowed.
 */
export async function resolveSpecHeaderFooterContext(
  specId: string,
  db: Queryable = pool
): Promise<HeaderFooterGenerationContext | null> {
  const project = await findSoleOwningProject(specId, db);
  if (!project) return null;

  const resolved = await resolveHeaderFooterConfig({ projectId: project.id }, db);
  if (!resolved || resolved.layers.length === 0) return null;

  const clientName = await resolveClientName(resolved.context.clientLibraryId, db);
  const fieldValues: HeaderFooterFieldSource = {
    projectName: project.name,
    ...(clientName !== undefined ? { clientName } : {}),
  };

  return { composition: resolved.config, fieldValues };
}
