import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { resolveHeaderFooterConfig, type ResolveHeaderFooterConfigInput } from './header-footer.js';
import { findLibraryById } from './libraries.js';
import { parseSectionNumberFormat } from '../../lib/section-number.js';
import type { SectionNumberFormat } from '../../lib/section-number.js';
import type { HeaderFooterComposition } from '../../ast/index.js';
import { effectiveSectionNumberFormatSql } from './section-number-format-sql.js';

interface Queryable {
  query: Pool['query'];
}

interface SoleOwningProjectRow {
  readonly id: string;
  readonly name: string;
  readonly section_number_format: string;
}

/**
 * The minimal project identity `buildHeaderFooterFromProject` needs: an id to
 * resolve the header/footer cascade from, and a name to stamp into
 * `fieldValues.projectName`. Deliberately narrower than any one caller's full
 * project row (`SoleOwningProjectRow`'s sole-ownership resolution,
 * `ProjectWithToc`'s manual-generation lookup) so both structurally satisfy
 * it without either caller re-shaping its own row for this call.
 */
export interface ProjectIdentity {
  readonly id: string;
  readonly name: string;
}

/**
 * Header/footer identity-field facts sourced from the DB for a resolved
 * generation context. No `date` here — date is generation-time, not a DB
 * fact; each consumer (src/api/generate-header-footer.ts, src/mcp/handlers.ts)
 * stamps it separately. `packageName`/`revisionName`/`revisionLabel` are
 * populated on the revision-scoped manual path
 * (`resolveRevisionHeaderFooterContext`) but always resolve `undefined` on
 * the single-spec path (`resolveSpecGenerationContext`'s `.headerFooter`) —
 * a bare `specId` has no verified, unambiguous package/revision (#304).
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
    const formatSql = effectiveSectionNumberFormatSql('p');
    const { rows } = await db.query<SoleOwningProjectRow>(
      `SELECT DISTINCT p.id, p.name,
              ${formatSql.select} AS section_number_format
       FROM projects p
       ${formatSql.clientJoin}
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
 * The shared prelude to every scoped header/footer context: resolve the
 * cascade for `target`, gate on at least one configured layer, and resolve
 * the client display name. Returns null when zero layers are configured
 * anywhere in the chain — `resolveHeaderFooterConfig` always returns a
 * non-null `{ config: {} }` even with zero rows, so `layers.length` is the
 * only real "configured" signal. Single-sourcing this gate keeps the
 * null-fallthrough (byte-identical pre-#304/#481 output) from drifting
 * between the project- and revision-scoped callers as more scopes are added.
 */
async function resolveConfigWithClientName(
  target: ResolveHeaderFooterConfigInput,
  db: Queryable
): Promise<{ composition: HeaderFooterComposition; clientName: string | undefined } | null> {
  const resolved = await resolveHeaderFooterConfig(target, db);
  if (!resolved || resolved.layers.length === 0) return null;

  const clientName = await resolveClientName(resolved.context.clientLibraryId, db);
  return { composition: resolved.config, clientName };
}

/**
 * Build the header/footer generation context for a project, or null when
 * that project has zero configured header/footer layers anywhere in its
 * client→project chain.
 *
 * Never invents package/revision-level context on its own: `project` carries
 * only id/name, so `HeaderFooterFieldSource.packageName`/`revisionName`/
 * `revisionLabel` stay undefined here — callers that DO have a verified
 * package/revision (`resolveRevisionHeaderFooterContext`) fill those in
 * separately rather than through this project-scoped builder.
 */
async function buildHeaderFooterFromProject(
  project: ProjectIdentity,
  db: Queryable
): Promise<HeaderFooterGenerationContext | null> {
  const resolved = await resolveConfigWithClientName({ projectId: project.id }, db);
  if (!resolved) return null;

  const fieldValues: HeaderFooterFieldSource = {
    projectName: project.name,
    ...(resolved.clientName !== undefined ? { clientName: resolved.clientName } : {}),
  };

  return { composition: resolved.composition, fieldValues };
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
 * Resolve the header/footer generation context for a whole-manual (project)
 * DOCX build (#481) — the project-scoped counterpart to
 * `resolveSpecGenerationContext`'s `.headerFooter` (the single-spec path).
 * Callers here already hold a verified project (e.g. `findProjectById`), so
 * unlike the single-spec path there is no sole-ownership lookup to perform
 * first: `projectId`/`projectName` are
 * taken as given and passed straight through to the shared builder. Null
 * when the project's client→project chain has zero configured layers.
 */
export async function resolveProjectManualHeaderFooterContext(
  projectId: string,
  projectName: string,
  db: Queryable = pool
): Promise<HeaderFooterGenerationContext | null> {
  return buildHeaderFooterFromProject({ id: projectId, name: projectName }, db);
}

/**
 * Identity-field facts for a revision-scoped manual build, threaded in by the
 * caller from its own already-fetched `RevisionManualData` snapshot (never
 * re-queried here) — one ownership snapshot per generation call, same
 * no-TOCTOU discipline as `resolveSpecGenerationContext`'s sole-owner read.
 */
export interface RevisionHeaderFooterFieldSource {
  readonly projectName: string;
  readonly packageName: string;
  readonly revisionName: string;
  readonly revisionLabel: string;
}

/**
 * Resolve the header/footer generation context for a package-revision manual
 * DOCX build (#481), cascading client→project→package→revision via the same
 * `resolveHeaderFooterConfig` used by the CRUD/resolved-view endpoints. Null
 * when zero layers are configured anywhere in that revision's chain.
 *
 * `fieldSource` values are stamped into `fieldValues` verbatim — they come
 * from the caller's own `RevisionManualData` fetch, not a second DB read, so
 * a concurrent rename between that fetch and this resolve can never produce
 * a mixed-snapshot header/footer.
 */
export async function resolveRevisionHeaderFooterContext(
  revisionId: string,
  fieldSource: RevisionHeaderFooterFieldSource,
  db: Queryable = pool
): Promise<HeaderFooterGenerationContext | null> {
  const resolved = await resolveConfigWithClientName({ revisionId }, db);
  if (!resolved) return null;

  const fieldValues: HeaderFooterFieldSource = {
    projectName: fieldSource.projectName,
    packageName: fieldSource.packageName,
    revisionName: fieldSource.revisionName,
    revisionLabel: fieldSource.revisionLabel,
    ...(resolved.clientName !== undefined ? { clientName: resolved.clientName } : {}),
  };

  return { composition: resolved.composition, fieldValues };
}
