import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { logger } from '../../lib/logger.js';
import { reconcileProjectDivisionGeneralSpec } from './division-general.js';

/** Copy-on-derive (ADR-015 D2/D3, issue #94): project sections are owned
 *  clones of master specs, resolved through the project's ordered source list.
 *  The clone is SQL set-based and lossless by construction — it never
 *  round-trips through getSpecTree/buildTree (which drops empty paragraphs). */

/** Target project does not exist → 404 at the API layer. */
export class ProjectNotFoundError extends DatabaseError {}
/** No source library of the project holds the section → 422 at the API layer. */
export class SectionUnresolvedError extends DatabaseError {}

export interface SourceLibraryRef {
  readonly libraryId: string;
  readonly name: string;
}

export interface AddSectionResult {
  readonly specId: string;
  readonly section: string;
  readonly position: number;
  readonly source: SourceLibraryRef;
  readonly shadowed?: readonly SourceLibraryRef[];
}

interface ResolutionRow {
  readonly spec_id: string;
  readonly library_id: string;
  readonly name: string;
}

interface Resolution {
  readonly master: ResolutionRow;
  readonly shadowed: readonly SourceLibraryRef[];
}

/** Walk project_sources by priority; first library holding the section wins.
 *  Other sources that also hold it are surfaced as the shadowed advisory. */
async function resolveSection(
  projectId: string,
  section: string,
  client: PoolClient
): Promise<Resolution> {
  const res = await client.query<ResolutionRow>(
    // Withdrawn masters (ADR-030) are not resolvable into a project — a section
    // held only by a withdrawn master resolves as if no source holds it.
    `SELECT s.id AS spec_id, ps.library_id, l.name
     FROM project_sources ps
     JOIN libraries l ON l.id = ps.library_id
     JOIN specs s ON s.library_id = ps.library_id AND s.section = $2
     WHERE ps.project_id = $1 AND s.withdrawn_at IS NULL
     ORDER BY ps.priority, s.created_at, s.id`,
    [projectId, section]
  );
  const master = res.rows[0];
  if (!master) {
    const proj = await client.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (proj.rowCount === 0) {
      throw new ProjectNotFoundError(`addSectionToProject: project ${projectId} not found`);
    }
    // User-facing via the 422 surface — no internal function-name prefix.
    throw new SectionUnresolvedError(
      `no source library of project ${projectId} holds section ${section}`
    );
  }
  const shadowed = new Map<string, SourceLibraryRef>();
  for (const row of res.rows.slice(1)) {
    if (row.library_id !== master.library_id && !shadowed.has(row.library_id)) {
      shadowed.set(row.library_id, { libraryId: row.library_id, name: row.name });
    }
  }
  return { master, shadowed: [...shadowed.values()] };
}

/** Clone the spec row; lineage per ADR-015 D2 (origin_meta keeps file provenance true). */
async function cloneSpecRow(
  projectId: string,
  masterId: string,
  client: PoolClient
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO specs
       (section, title, source, project_id, parent_spec_id, origin_version,
        content_version, origin_meta)
     SELECT s.section, s.title, s.source, $1, s.id, s.content_version, 1, s.origin_meta
     FROM specs s WHERE s.id = $2
     RETURNING id`,
    [projectId, masterId]
  );
  const row = res.rows[0];
  if (!row) throw new DatabaseError(`cloneSpecRow: master spec ${masterId} vanished`);
  return row.id;
}

/** Set-based paragraph clone: UUID-map CTE, parent_id remapped via self-join,
 *  origin_paragraph_id records the mapping. Lossless by construction. */
async function cloneParagraphs(
  masterId: string,
  cloneId: string,
  client: PoolClient
): Promise<void> {
  await client.query(
    `WITH map AS (
       SELECT id AS old_id, gen_random_uuid() AS new_id
       FROM paragraphs WHERE spec_id = $1
     )
     INSERT INTO paragraphs
       (id, spec_id, parent_id, node_type, text, position, vanish, revit_param,
        base_version, conflicts, source_facts, origin_paragraph_id)
     SELECT m.new_id, $2, pm.new_id, p.node_type, p.text, p.position, p.vanish,
            p.revit_param, p.base_version, p.conflicts, p.source_facts, p.id
     FROM paragraphs p
     JOIN map m ON m.old_id = p.id
     LEFT JOIN map pm ON pm.old_id = p.parent_id`,
    [masterId, cloneId]
  );
}

/** Clone outgoing refs. origin_paragraph_id doubles as the paragraph UUID map.
 *  Target resolution is project-scope first: a section already among this
 *  project's specs resolves; otherwise NULL + is_broken (repaired when the
 *  section is later added). Cross-spec paragraph targets cannot be mapped into
 *  another spec's clone → NULL via the scoped tp join. */
async function cloneRefs(
  projectId: string,
  masterId: string,
  cloneId: string,
  client: PoolClient
): Promise<void> {
  await client.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section,
        target_spec_id, target_paragraph_id, standard_code, reference_text, is_broken)
     SELECT $3, sp.id, sr.target_type, sr.target_spec_section,
            tgt.id, tp.id, sr.standard_code, sr.reference_text,
            (sr.target_type = 'section' AND tgt.id IS NULL)
     FROM spec_references sr
     JOIN paragraphs sp ON sp.spec_id = $3 AND sp.origin_paragraph_id = sr.source_paragraph_id
     LEFT JOIN paragraphs tp ON tp.spec_id = $3 AND tp.origin_paragraph_id = sr.target_paragraph_id
     LEFT JOIN specs tgt ON tgt.project_id = $1 AND tgt.section = sr.target_spec_section
     WHERE sr.source_spec_id = $2`,
    [projectId, masterId, cloneId]
  );
}

/** TOC row at max+1, plus project-scoped repair of broken refs that were
 *  waiting for this section (project-scoped broken-ref repair CTE). */
async function insertTocEntry(
  projectId: string,
  cloneId: string,
  section: string,
  client: PoolClient
): Promise<number> {
  const res = await client.query<{ position: number }>(
    `WITH inserted AS (
       INSERT INTO project_specs (project_id, spec_id, position)
       SELECT $1, $2, COALESCE(MAX(position), 0) + 1
       FROM project_specs WHERE project_id = $1
       RETURNING position
     ),
     repaired AS (
       UPDATE spec_references sr
       SET target_spec_id = $2, is_broken = false
       FROM project_specs ps
       WHERE sr.target_spec_section = $3
         AND sr.is_broken = true
         AND sr.source_spec_id = ps.spec_id
         AND ps.project_id = $1
         AND EXISTS (SELECT 1 FROM inserted)
     )
     SELECT position FROM inserted`,
    [projectId, cloneId, section]
  );
  const row = res.rows[0];
  if (!row) throw new DatabaseError('insertTocEntry: no row returned after insert');
  return row.position;
}

export type RemoveSectionOutcome = 'removed' | 'not-found' | 'edited' | 'in-package';

/** SELECT ... FOR UPDATE, apply the block-if-edited guard, then check package
 *  membership (ADR-015 D4, migration 020). package_specs.spec_id is ON DELETE
 *  RESTRICT so even a forced delete cannot proceed while the spec is in a
 *  package — the check runs regardless of `force`.
 *  Returns null when all guards pass (proceed to delete). */
async function guardRemoval(
  projectId: string,
  specId: string,
  force: boolean,
  client: PoolClient
): Promise<RemoveSectionOutcome | null> {
  const owned = await client.query<{ content_version: number }>(
    `SELECT content_version FROM specs WHERE id = $2 AND project_id = $1 FOR UPDATE`,
    [projectId, specId]
  );
  const row = owned.rows[0];
  if (!row) return 'not-found';
  if (row.content_version > 1 && !force) return 'edited';
  const inPackage = await client.query('SELECT 1 FROM package_specs WHERE spec_id = $1 LIMIT 1', [
    specId,
  ]);
  if ((inPackage.rowCount ?? 0) > 0) return 'in-package';
  return null;
}

/** Mark incoming refs from other project specs broken before the FK SET NULL fires. */
async function markIncomingRefsBroken(
  projectId: string,
  specId: string,
  client: PoolClient
): Promise<void> {
  await client.query(
    `UPDATE spec_references sr SET is_broken = true
     FROM project_specs ps
     WHERE sr.target_spec_id = $2
       AND sr.source_spec_id = ps.spec_id
       AND ps.project_id = $1
       AND sr.source_spec_id <> $2`,
    [projectId, specId]
  );
}

/** Delete a project-owned clone (TOC row, refs, paragraph tree). Edited clones
 *  (content_version > 1) are blocked unless force — the caller maps 'edited'
 *  to 409 and surfaces ?force=true. Incoming refs from the project's other
 *  specs are marked broken first (target_spec_id then SET NULL by FK). */
export async function removeSectionFromProject(
  projectId: string,
  specId: string,
  force: boolean,
  db: Pool = pool
): Promise<RemoveSectionOutcome> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const early = await guardRemoval(projectId, specId, force, client);
    if (early !== null) {
      await client.query('ROLLBACK');
      return early;
    }
    await markIncomingRefsBroken(projectId, specId, client);
    await client.query(`DELETE FROM project_specs WHERE project_id = $1 AND spec_id = $2`, [
      projectId,
      specId,
    ]);
    await client.query(`DELETE FROM specs WHERE id = $1`, [specId]);
    await client.query('COMMIT');
    logger.info({ projectId, specId, force }, 'removeSectionFromProject: clone deleted');
    return 'removed';
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    throw new DatabaseError(`removeSectionFromProject: failed for spec ${specId}`, { cause: err });
  } finally {
    client.release();
  }
}

/** Resolve a section through the project's source list and clone the winning
 *  master into a project-owned copy. One transaction; all-or-nothing. */
export async function addSectionToProject(
  projectId: string,
  section: string,
  db: Pool = pool
): Promise<AddSectionResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { master, shadowed } = await resolveSection(projectId, section, client);
    const cloneId = await cloneSpecRow(projectId, master.spec_id, client);
    await cloneParagraphs(master.spec_id, cloneId, client);
    await cloneRefs(projectId, master.spec_id, cloneId, client);
    const position = await insertTocEntry(projectId, cloneId, section, client);
    await reconcileProjectDivisionGeneralSpec(projectId, section, client);
    await client.query('COMMIT');
    logger.info(
      { projectId, section, cloneId, masterId: master.spec_id },
      'addSectionToProject: section cloned into project'
    );
    return {
      specId: cloneId,
      section,
      position,
      source: { libraryId: master.library_id, name: master.name },
      ...(shadowed.length > 0 ? { shadowed } : {}),
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `addSectionToProject: failed for section ${section} in project ${projectId}`,
      { cause: err }
    );
  } finally {
    client.release();
  }
}
