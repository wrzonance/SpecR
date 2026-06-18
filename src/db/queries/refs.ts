import { DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { SecRef } from '../../ast/types.js';
import { logger } from '../../lib/logger.js';

interface Queryable {
  query: Pool['query'];
}

interface OutboundReferenceRow {
  readonly source_spec_id: string;
  readonly reference_text: string;
  readonly target_spec_section: string | null;
  readonly target_spec_id: string | null;
  readonly is_broken: boolean;
}

interface InboundReferenceRow {
  readonly source_spec_id: string;
  readonly source_section: string;
  readonly source_title: string;
  readonly source_paragraph_id: string;
  readonly reference_text: string;
  readonly target_spec_id: string | null;
  readonly is_broken: boolean;
}

export interface OutboundReference {
  readonly sourceSpecId: string;
  readonly referenceText: string;
  readonly targetSection: string | null;
  readonly targetSpecId: string | null;
  readonly isResolved: boolean;
  readonly isBroken: boolean;
}

export interface InboundReference {
  readonly sourceSpecId: string;
  readonly sourceSection: string;
  readonly sourceTitle: string;
  readonly sourceParagraphId: string;
  readonly referenceText: string;
  readonly isResolved: boolean;
  readonly isBroken: boolean;
}

function mapOutbound(row: OutboundReferenceRow): OutboundReference {
  return {
    sourceSpecId: row.source_spec_id,
    referenceText: row.reference_text,
    targetSection: row.target_spec_section,
    targetSpecId: row.target_spec_id,
    isResolved: row.target_spec_id !== null,
    isBroken: row.is_broken,
  };
}

function mapInbound(row: InboundReferenceRow): InboundReference {
  return {
    sourceSpecId: row.source_spec_id,
    sourceSection: row.source_section,
    sourceTitle: row.source_title,
    sourceParagraphId: row.source_paragraph_id,
    referenceText: row.reference_text,
    isResolved: row.target_spec_id !== null,
    isBroken: row.is_broken,
  };
}

export async function insertRefs(
  refs: readonly SecRef[],
  specId: string,
  pool: Queryable
): Promise<void> {
  if (refs.length === 0) {
    return;
  }

  for (const ref of refs) {
    try {
      let targetSpecId: string | null = null;

      if (ref.targetType === 'section' && ref.targetSpecSection) {
        const result = await pool.query<{ id: string }>(
          'SELECT id FROM specs WHERE section = $1 LIMIT 1',
          [ref.targetSpecSection]
        );
        targetSpecId = result.rows[0]?.id ?? null;
      }

      await pool.query(
        `INSERT INTO spec_references
           (source_spec_id, source_paragraph_id, target_type,
            target_spec_section, target_spec_id, standard_code, reference_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          specId,
          ref.sourceNodeId,
          ref.targetType,
          ref.targetSpecSection ?? null,
          targetSpecId,
          ref.standardCode ?? null,
          ref.referenceText,
        ]
      );
    } catch (err) {
      throw new DatabaseError(`insertRefs: failed on ref ${ref.sourceNodeId} (${ref.targetType})`, {
        cause: err,
      });
    }
  }

  logger.info({ specId, count: refs.length }, 'insertRefs: references inserted');
}

export async function getInboundReferences(
  section: string,
  projectId: string,
  pool: Queryable
): Promise<readonly InboundReference[]> {
  try {
    const result = await pool.query<InboundReferenceRow>(
      `SELECT sr.source_spec_id, s.section AS source_section, s.title AS source_title,
              sr.source_paragraph_id, sr.reference_text, sr.target_spec_id, sr.is_broken
       FROM spec_references sr
       JOIN specs s ON sr.source_spec_id = s.id
       JOIN project_specs ps ON ps.spec_id = sr.source_spec_id
       WHERE ps.project_id = $2 AND sr.target_spec_section = $1
       ORDER BY s.section, sr.source_paragraph_id`,
      [section, projectId]
    );
    return result.rows.map(mapInbound);
  } catch (err) {
    throw new DatabaseError(
      `getInboundReferences: query failed for project ${projectId}, section ${section}`,
      { cause: err }
    );
  }
}

export async function getOutboundReferences(
  specId: string,
  projectId: string,
  pool: Queryable
): Promise<readonly OutboundReference[]> {
  try {
    const result = await pool.query<OutboundReferenceRow>(
      `SELECT sr.source_spec_id, sr.reference_text, sr.target_spec_section,
              sr.target_spec_id, sr.is_broken
       FROM spec_references sr
       JOIN project_specs ps ON ps.spec_id = sr.source_spec_id
       WHERE sr.source_spec_id = $1 AND ps.project_id = $2
       ORDER BY sr.source_paragraph_id`,
      [specId, projectId]
    );
    return result.rows.map(mapOutbound);
  } catch (err) {
    throw new DatabaseError(
      `getOutboundReferences: query failed for project ${projectId}, spec ${specId}`,
      { cause: err }
    );
  }
}

export async function findProjectSpecIdsBySection(
  section: string,
  projectId: string,
  pool: Queryable
): Promise<readonly string[]> {
  try {
    const result = await pool.query<{ id: string }>(
      `SELECT s.id
       FROM specs s
       JOIN project_specs ps ON ps.spec_id = s.id
       WHERE ps.project_id = $2 AND s.section = $1
       ORDER BY s.id`,
      [section, projectId]
    );
    return result.rows.map((row) => row.id);
  } catch (err) {
    throw new DatabaseError(
      `findProjectSpecIdsBySection: query failed for project ${projectId}, section ${section}`,
      { cause: err }
    );
  }
}

export async function isSpecInProject(
  specId: string,
  projectId: string,
  pool: Queryable
): Promise<boolean> {
  try {
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM project_specs WHERE project_id = $1 AND spec_id = $2
       ) AS exists`,
      [projectId, specId]
    );
    return result.rows[0]?.exists ?? false;
  } catch (err) {
    throw new DatabaseError(
      `isSpecInProject: query failed for project ${projectId}, spec ${specId}`,
      { cause: err }
    );
  }
}
