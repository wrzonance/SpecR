import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import type { ParagraphAssociation } from '../../ast/index.js';
import { logger } from '../../lib/logger.js';

interface Queryable {
  query: Pool['query'];
}

/** Target paragraph does not exist → 404 at the API layer. */
export class AssociationParagraphNotFoundError extends DatabaseError {}

export interface CreateAssociationInput {
  readonly label: string;
  readonly externalProvider?: string;
  readonly externalId?: string;
  readonly url?: string;
  readonly contentHash?: string;
  readonly externalMetadata?: Record<string, unknown>;
}

interface AssociationRow {
  readonly id: string;
  readonly paragraph_id: string;
  readonly label: string;
  readonly external_provider: string | null;
  readonly external_id: string | null;
  readonly url: string | null;
  readonly content_hash: string | null;
  readonly external_metadata: Record<string, unknown>;
  readonly created_at: Date;
}

const SELECT_COLS =
  'id, paragraph_id, label, external_provider, external_id, url, content_hash, external_metadata, created_at';

function mapRow(row: AssociationRow): ParagraphAssociation {
  return {
    id: row.id,
    label: row.label,
    ...(row.external_provider !== null ? { externalProvider: row.external_provider } : {}),
    ...(row.external_id !== null ? { externalId: row.external_id } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    externalMetadata: row.external_metadata,
    createdAt: row.created_at.toISOString(),
  };
}

async function resolveSpecId(paragraphId: string, db: Queryable): Promise<string> {
  const res = await db.query<{ spec_id: string }>(`SELECT spec_id FROM paragraphs WHERE id = $1`, [
    paragraphId,
  ]);
  const row = res.rows[0];
  if (!row) {
    throw new AssociationParagraphNotFoundError(`paragraph ${paragraphId} not found`);
  }
  return row.spec_id;
}

export async function createAssociation(
  paragraphId: string,
  input: CreateAssociationInput,
  db: Pool = pool
): Promise<ParagraphAssociation> {
  try {
    const specId = await resolveSpecId(paragraphId, db);
    const res = await db.query<AssociationRow>(
      `INSERT INTO paragraph_associations
         (paragraph_id, spec_id, label, external_provider, external_id, url, content_hash, external_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING ${SELECT_COLS}`,
      [
        paragraphId,
        specId,
        input.label,
        input.externalProvider ?? null,
        input.externalId ?? null,
        input.url ?? null,
        input.contentHash ?? null,
        JSON.stringify(input.externalMetadata ?? {}),
      ]
    );
    const row = res.rows[0];
    if (!row) throw new DatabaseError('createAssociation: insert returned no row');
    logger.info({ paragraphId, associationId: row.id }, 'association created');
    return mapRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`createAssociation failed for paragraph ${paragraphId}`, {
      cause: err,
    });
  }
}

export async function listAssociationsForParagraph(
  paragraphId: string,
  db: Queryable = pool
): Promise<readonly ParagraphAssociation[]> {
  try {
    const res = await db.query<AssociationRow>(
      `SELECT ${SELECT_COLS} FROM paragraph_associations
       WHERE paragraph_id = $1 ORDER BY created_at, id`,
      [paragraphId]
    );
    return res.rows.map(mapRow);
  } catch (err) {
    throw new DatabaseError(`listAssociationsForParagraph failed for ${paragraphId}`, {
      cause: err,
    });
  }
}

export async function listAssociationsForSpec(
  specId: string,
  db: Queryable = pool
): Promise<ReadonlyMap<string, readonly ParagraphAssociation[]>> {
  try {
    const res = await db.query<AssociationRow>(
      `SELECT ${SELECT_COLS} FROM paragraph_associations
       WHERE spec_id = $1 ORDER BY created_at, id`,
      [specId]
    );
    const map = new Map<string, ParagraphAssociation[]>();
    for (const row of res.rows) {
      const list = map.get(row.paragraph_id) ?? [];
      list.push(mapRow(row));
      map.set(row.paragraph_id, list);
    }
    return map;
  } catch (err) {
    throw new DatabaseError(`listAssociationsForSpec failed for ${specId}`, { cause: err });
  }
}

export async function deleteAssociation(
  paragraphId: string,
  associationId: string,
  db: Pool = pool
): Promise<boolean> {
  try {
    const res = await db.query(
      `DELETE FROM paragraph_associations WHERE id = $1 AND paragraph_id = $2`,
      [associationId, paragraphId]
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    throw new DatabaseError(`deleteAssociation failed for ${associationId}`, { cause: err });
  }
}
