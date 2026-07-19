import type { Pool } from 'pg';
import { DatabaseError } from '../errors.js';
import { assertClientExists, ClientNotFoundError } from './clients.js';
import { getPgCode } from '../../lib/pg-errors.js';
import { parseSectionNumberFormat } from '../../lib/section-number.js';
import type { SectionNumberFormat } from '../../lib/section-number.js';

interface Queryable {
  query: Pool['query'];
}

export interface UpdateProjectInput {
  readonly name?: string;
  /** null clears the project override so the client/firm default applies. */
  readonly sectionNumberFormat?: SectionNumberFormat | null;
  /** Absent = unchanged; null = disassociate; uuid = associate (ADR-054). */
  readonly clientId?: string | null;
}

export interface UpdateProjectResult {
  readonly id: string;
  readonly name: string;
  readonly sectionNumberFormat: SectionNumberFormat;
  readonly clientId: string | null;
}

interface UpdateProjectRow {
  readonly id: string;
  readonly name: string;
  readonly section_number_format: string;
  readonly client_id: string | null;
}

function buildProjectUpdate(
  id: string,
  input: UpdateProjectInput
): { setClauses: string[]; params: (string | null)[] } {
  const setClauses: string[] = ['updated_at = now()'];
  const params: (string | null)[] = [id];
  if (input.name !== undefined) {
    params.push(input.name);
    setClauses.push(`name = $${params.length}`);
  }
  if (input.sectionNumberFormat !== undefined) {
    params.push(input.sectionNumberFormat);
    setClauses.push(`section_number_format = $${params.length}`);
  }
  if (input.clientId !== undefined) {
    params.push(input.clientId);
    setClauses.push(`client_id = $${params.length}`);
  }
  return { setClauses, params };
}

function projectUpdateSql(setClauses: readonly string[]): string {
  return `WITH updated AS (
    UPDATE projects SET ${setClauses.join(', ')} WHERE id = $1
    RETURNING id, name, section_number_format, client_id
  )
  SELECT u.id, u.name,
         COALESCE(u.section_number_format, c.section_number_format, 'canonical')
           AS section_number_format,
         u.client_id
    FROM updated u
    LEFT JOIN clients c ON c.id = u.client_id`;
}

/** Partial project update. A null format clears the project override. */
export async function updateProject(
  id: string,
  input: UpdateProjectInput,
  db: Queryable
): Promise<UpdateProjectResult | null> {
  const { setClauses, params } = buildProjectUpdate(id, input);
  try {
    if (typeof input.clientId === 'string') await assertClientExists(input.clientId, db);
    const { rows } = await db.query<UpdateProjectRow>(projectUpdateSql(setClauses), params);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      sectionNumberFormat: parseSectionNumberFormat(row.section_number_format),
      clientId: row.client_id,
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    const wrapped = new DatabaseError(`updateProject: update failed for ${id}`, { cause: err });
    if (typeof input.clientId === 'string' && getPgCode(wrapped) === '23503') {
      throw new ClientNotFoundError(`client ${input.clientId} not found`, { cause: err });
    }
    throw wrapped;
  }
}
