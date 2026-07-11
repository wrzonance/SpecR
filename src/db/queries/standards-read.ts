import type { Pool, PoolClient } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { ProjectNotFoundError } from './derive.js';
import { LibraryNotFoundError } from './libraries.js';
import {
  buildStandardsRollup,
  type StandardCitationRow,
  type StandardRegistryRow,
  type StandardStatus,
  type StandardsRollup,
} from './standards.js';

export type StandardsScope =
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'library'; readonly id: string };

/** A full registry row (the PUT verdict response + rollup join source). */
export interface StandardRecord {
  readonly id: string;
  readonly orgCode: string;
  readonly standardCode: string;
  readonly title: string | null;
  readonly currentVersion: string | null;
  readonly sourceUrl: string | null;
  readonly status: StandardStatus;
  readonly lastVerifiedAt: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** PUT /standards/{orgCode}/{standardCode} body — a full verdict (PUT-replace,
 *  ADR-064 §3): omitted fields reset to null; status defaults to 'unknown'. */
export interface RecordVerificationInput {
  readonly orgCode: string;
  readonly standardCode: string;
  readonly status?: StandardStatus | undefined;
  readonly currentVersion?: string | null | undefined;
  readonly sourceUrl?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

interface CitationSqlRow {
  readonly standard_code: string;
  readonly source_spec_id: string;
  readonly source_spec_section: string;
  readonly source_paragraph_id: string;
}
// The verdict columns shared by the rollup SELECT and the upsert RETURNING.
interface RegistrySqlRow {
  readonly org_code: string;
  readonly standard_code: string;
  readonly title: string | null;
  readonly current_version: string | null;
  readonly source_url: string | null;
  readonly status: StandardStatus;
  readonly last_verified_at: Date | null;
  readonly notes: string | null;
}
// The RETURNING shape adds the identity + audit columns (always present).
interface RegistryRecordRow extends RegistrySqlRow {
  readonly id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const REGISTRY_COLUMNS =
  'id, org_code, standard_code, title, current_version, source_url, status, last_verified_at, notes, created_at, updated_at';

async function assertScopeExists(scope: StandardsScope, client: PoolClient): Promise<void> {
  if (scope.kind === 'project') {
    const r = await client.query('SELECT 1 FROM projects WHERE id = $1', [scope.id]);
    if ((r.rowCount ?? 0) === 0) throw new ProjectNotFoundError(`project ${scope.id} not found`);
    return;
  }
  const r = await client.query('SELECT 1 FROM libraries WHERE id = $1', [scope.id]);
  if ((r.rowCount ?? 0) === 0) throw new LibraryNotFoundError(`library ${scope.id} not found`);
}

// Withdrawn masters (ADR-030) never contribute citations — matching coordination's
// present set. Ordered so the per-standard anchor cap is a deterministic subset.
async function readCitations(
  scope: StandardsScope,
  client: PoolClient
): Promise<StandardCitationRow[]> {
  const scopeJoin =
    scope.kind === 'project'
      ? 'JOIN project_specs ps ON ps.spec_id = sr.source_spec_id AND ps.project_id = $1'
      : '';
  const scopeWhere = scope.kind === 'project' ? '' : 'AND s.library_id = $1';
  const r = await client.query<CitationSqlRow>(
    `SELECT sr.standard_code, sr.source_spec_id,
            s.section AS source_spec_section, sr.source_paragraph_id
       FROM spec_references sr
       ${scopeJoin}
       JOIN specs s ON s.id = sr.source_spec_id
      WHERE sr.target_type = 'standard'
        AND sr.standard_code IS NOT NULL
        AND s.withdrawn_at IS NULL
        ${scopeWhere}
      ORDER BY sr.standard_code, s.section, sr.source_spec_id, sr.source_paragraph_id`,
    [scope.id]
  );
  return r.rows.map((row) => ({
    standardCode: row.standard_code,
    sourceSpecId: row.source_spec_id,
    sourceSpecSection: row.source_spec_section,
    sourceParagraphId: row.source_paragraph_id,
  }));
}

function toRegistryRow(row: RegistrySqlRow): StandardRegistryRow {
  return {
    orgCode: row.org_code,
    standardCode: row.standard_code,
    title: row.title,
    currentVersion: row.current_version,
    sourceUrl: row.source_url,
    status: row.status,
    lastVerifiedAt: row.last_verified_at ? row.last_verified_at.toISOString() : null,
    notes: row.notes,
  };
}

async function readRegistry(client: PoolClient): Promise<StandardRegistryRow[]> {
  const r = await client.query<RegistrySqlRow>(
    'SELECT org_code, standard_code, title, current_version, source_url, status, last_verified_at, notes FROM standards'
  );
  return r.rows.map(toRegistryRow);
}

/**
 * One-call standards rollup for a project or library (#446). Compiles the distinct
 * cited standards in scope, joins each to its global registry verdict, and derives
 * superseded/withdrawn findings — inside a READ ONLY snapshot. Throws
 * ProjectNotFoundError / LibraryNotFoundError on a missing scope id.
 */
export async function getStandardsRollup(
  scope: StandardsScope,
  db: Pool = pool
): Promise<StandardsRollup> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await assertScopeExists(scope, client);
    const citations = await readCitations(scope, client);
    const registry = await readRegistry(client);
    await client.query('COMMIT');
    return buildStandardsRollup({ type: scope.kind, id: scope.id }, citations, registry);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) throw err;
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getStandardsRollup failed for ${scope.kind} ${scope.id}`, {
      cause: err,
    });
  } finally {
    if (client) client.release();
  }
}

function mapRecord(row: RegistryRecordRow): StandardRecord {
  return {
    id: row.id,
    orgCode: row.org_code,
    standardCode: row.standard_code,
    title: row.title,
    currentVersion: row.current_version,
    sourceUrl: row.source_url,
    status: row.status,
    lastVerifiedAt: row.last_verified_at ? row.last_verified_at.toISOString() : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Normalize the registry key to match parseStandardCitation's rollup key (org
// uppercased/trimmed, code trimmed) and backstop the two API boundaries: a blank
// code would upsert the org-only key ADR-064 §2 reserves for ambiguous citations,
// wrongly attaching a verdict to every ambiguous citation for that org.
function normalizeVerificationKey(input: RecordVerificationInput): {
  readonly orgCode: string;
  readonly standardCode: string;
} {
  const orgCode = input.orgCode.trim().toUpperCase();
  const standardCode = input.standardCode.trim();
  if (orgCode === '' || standardCode === '') {
    throw new DatabaseError(
      'recordStandardVerification: orgCode and standardCode must not be blank'
    );
  }
  return { orgCode, standardCode };
}

/**
 * Upsert a standards verdict (ADR-064 §3). Normalizes orgCode to uppercase/trimmed
 * and trims standardCode so the key matches parseStandardCitation's rollup key, then
 * stamps last_verified_at = now(). PUT-replace: omitted optional fields reset to null.
 */
export async function recordStandardVerification(
  input: RecordVerificationInput,
  db: Pool = pool
): Promise<StandardRecord> {
  const { orgCode, standardCode } = normalizeVerificationKey(input);
  try {
    const r = await db.query<RegistryRecordRow>(
      `INSERT INTO standards
         (org_code, standard_code, title, current_version, source_url, status, notes, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (org_code, standard_code) DO UPDATE SET
         title = EXCLUDED.title,
         current_version = EXCLUDED.current_version,
         source_url = EXCLUDED.source_url,
         status = EXCLUDED.status,
         notes = EXCLUDED.notes,
         last_verified_at = EXCLUDED.last_verified_at,
         updated_at = now()
       RETURNING ${REGISTRY_COLUMNS}`,
      [
        orgCode,
        standardCode,
        input.title ?? null,
        input.currentVersion ?? null,
        input.sourceUrl ?? null,
        input.status ?? 'unknown',
        input.notes ?? null,
      ]
    );
    const row = r.rows[0];
    if (row === undefined) throw new DatabaseError('recordStandardVerification returned no row');
    return mapRecord(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`recordStandardVerification failed for ${orgCode} ${standardCode}`, {
      cause: err,
    });
  }
}
