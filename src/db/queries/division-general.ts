import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';

export type DivisionGeneralScope = 'library' | 'project';
export type DivisionGeneralStatus = 'resolved' | 'missing' | 'not_applicable';
export type DivisionGeneralMethod = 'exact_section' | 'manual';
export type DivisionGeneralCandidateReason = 'title_keyword' | 'first_in_division';
export type DivisionGeneralConfidence = 'medium' | 'low';

interface Queryable {
  query: Pool['query'];
}

interface SpecRow {
  readonly id: string;
  readonly section: string;
  readonly title: string;
}

interface ConfigRow {
  readonly status: 'resolved' | 'not_applicable';
  readonly detection_method: DivisionGeneralMethod;
  readonly notes: string | null;
  readonly id: string | null;
  readonly section: string | null;
  readonly title: string | null;
}

export interface DivisionGeneralSpecRef {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
}

export interface DivisionGeneralCandidate extends DivisionGeneralSpecRef {
  readonly rank: number;
  readonly reason: DivisionGeneralCandidateReason;
  readonly confidence: DivisionGeneralConfidence;
}

export interface DivisionGeneralSpecResult {
  readonly scope: DivisionGeneralScope;
  readonly ownerId: string;
  readonly division: string;
  readonly expectedSection: string;
  readonly status: DivisionGeneralStatus;
  readonly generalSpec: DivisionGeneralSpecRef | null;
  readonly detectionMethod: DivisionGeneralMethod | null;
  readonly notes: string | null;
  readonly message: string;
  readonly candidates: readonly DivisionGeneralCandidate[];
}

export interface SetDivisionGeneralSpecInput {
  readonly generalSpecId?: string;
  readonly status?: 'not_applicable';
  readonly notes?: string;
}

export class DivisionGeneralOwnerNotFoundError extends DatabaseError {}
export class DivisionGeneralSpecNotInScopeError extends DatabaseError {}

const GENERAL_TITLE_RE =
  /\b(general requirements|common work results|common requirements|general purpose)\b|(\bbasic\b.*\b(materials|methods)\b)/i;

function expectedSection(division: string): string {
  return `${division} 00 00`;
}

function specRef(row: SpecRow): DivisionGeneralSpecRef {
  return { specId: row.id, section: row.section, title: row.title };
}

function divisionOf(section: string): string | null {
  return /^\d{2} /.test(section) ? section.slice(0, 2) : null;
}

function messageFor(
  division: string,
  status: DivisionGeneralStatus,
  method: DivisionGeneralMethod | null
): string {
  if (status === 'resolved') {
    return method === 'exact_section'
      ? `${expectedSection(division)} found and assigned as the division general spec.`
      : `Division ${division} general spec was assigned manually.`;
  }
  if (status === 'not_applicable') {
    return `Division ${division} is marked as having no in-scope general requirements spec.`;
  }
  return `No ${expectedSection(division)} spec exists in this scope; candidates are advisory only.`;
}

function makeResult(input: {
  readonly scope: DivisionGeneralScope;
  readonly ownerId: string;
  readonly division: string;
  readonly status: DivisionGeneralStatus;
  readonly generalSpec: DivisionGeneralSpecRef | null;
  readonly detectionMethod: DivisionGeneralMethod | null;
  readonly notes: string | null;
  readonly candidates: readonly DivisionGeneralCandidate[];
}): DivisionGeneralSpecResult {
  return {
    ...input,
    expectedSection: expectedSection(input.division),
    message: messageFor(input.division, input.status, input.detectionMethod),
  };
}

function ownerColumn(scope: DivisionGeneralScope): 'library_id' | 'project_id' {
  return scope === 'library' ? 'library_id' : 'project_id';
}

function ownerTable(scope: DivisionGeneralScope): 'libraries' | 'projects' {
  return scope === 'library' ? 'libraries' : 'projects';
}

async function ownerExists(
  scope: DivisionGeneralScope,
  ownerId: string,
  db: Queryable
): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM ${ownerTable(scope)} WHERE id = $1`, [ownerId]);
  return (result.rowCount ?? 0) > 0;
}

async function findExistingConfig(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  db: Queryable
): Promise<ConfigRow | null> {
  const col = ownerColumn(scope);
  const result = await db.query<ConfigRow>(
    `SELECT d.status, d.detection_method, d.notes, s.id, s.section, s.title
     FROM division_general_specs d
     LEFT JOIN specs s ON s.id = d.general_spec_id
     WHERE d.${col} = $1 AND d.division = $2`,
    [ownerId, division]
  );
  return result.rows[0] ?? null;
}

async function findExactSpec(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  db: Queryable
): Promise<SpecRow | null> {
  const col = ownerColumn(scope);
  const result = await db.query<SpecRow>(
    `SELECT id, section, title FROM specs
     WHERE ${col} = $1 AND section = $2
     ORDER BY created_at, id LIMIT 1`,
    [ownerId, expectedSection(division)]
  );
  return result.rows[0] ?? null;
}

async function listDivisionSpecs(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  db: Queryable
): Promise<readonly SpecRow[]> {
  const col = ownerColumn(scope);
  const result = await db.query<SpecRow>(
    `SELECT id, section, title FROM specs
     WHERE ${col} = $1 AND section LIKE $2
     ORDER BY section, created_at, id`,
    [ownerId, `${division} %`]
  );
  return result.rows;
}

function addCandidate(
  out: DivisionGeneralCandidate[],
  seen: Set<string>,
  row: SpecRow,
  reason: DivisionGeneralCandidateReason,
  confidence: DivisionGeneralConfidence
): void {
  if (seen.has(row.id)) return;
  seen.add(row.id);
  out.push({ ...specRef(row), rank: out.length + 1, reason, confidence });
}

function buildCandidates(rows: readonly SpecRow[]): readonly DivisionGeneralCandidate[] {
  const out: DivisionGeneralCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (GENERAL_TITLE_RE.test(row.title)) addCandidate(out, seen, row, 'title_keyword', 'medium');
  }
  const first = rows[0];
  if (first) addCandidate(out, seen, first, 'first_in_division', 'low');
  return out.slice(0, 10);
}

function resultFromConfig(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  row: ConfigRow
): DivisionGeneralSpecResult {
  const generalSpec =
    row.id && row.section && row.title
      ? { specId: row.id, section: row.section, title: row.title }
      : null;
  return makeResult({
    scope,
    ownerId,
    division,
    status: row.status,
    generalSpec,
    detectionMethod: row.detection_method,
    notes: row.notes,
    candidates: [],
  });
}

async function upsertExactConfig(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  specId: string,
  db: Queryable
): Promise<void> {
  const ownerField = ownerColumn(scope);
  await db.query(
    `INSERT INTO division_general_specs
       (${ownerField}, division, general_spec_id, status, detection_method, notes)
     VALUES ($1, $2, $3, 'resolved', 'exact_section', NULL)
     ON CONFLICT (${ownerField}, division) WHERE ${ownerField} IS NOT NULL
     DO UPDATE SET general_spec_id = EXCLUDED.general_spec_id,
                   status = 'resolved',
                   detection_method = 'exact_section',
                   notes = NULL,
                   updated_at = now()
     WHERE division_general_specs.detection_method = 'exact_section'`,
    [ownerId, division, specId]
  );
}

async function getDivisionGeneralSpec(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  db: Queryable = pool
): Promise<DivisionGeneralSpecResult | null> {
  try {
    if (!(await ownerExists(scope, ownerId, db))) return null;
    const config = await findExistingConfig(scope, ownerId, division, db);
    if (config) return resultFromConfig(scope, ownerId, division, config);
    const exact = await findExactSpec(scope, ownerId, division, db);
    if (exact) {
      await upsertExactConfig(scope, ownerId, division, exact.id, db);
      return makeResult({
        scope,
        ownerId,
        division,
        status: 'resolved',
        generalSpec: specRef(exact),
        detectionMethod: 'exact_section',
        notes: null,
        candidates: [],
      });
    }
    const candidates = buildCandidates(await listDivisionSpecs(scope, ownerId, division, db));
    return makeResult({
      scope,
      ownerId,
      division,
      status: 'missing',
      generalSpec: null,
      detectionMethod: null,
      notes: null,
      candidates,
    });
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getDivisionGeneralSpec failed for ${scope} ${ownerId}`, {
      cause: err,
    });
  }
}

async function findSpecInScope(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  specId: string,
  db: Queryable
): Promise<SpecRow> {
  const col = ownerColumn(scope);
  const result = await db.query<SpecRow>(
    `SELECT id, section, title FROM specs
     WHERE id = $1 AND ${col} = $2 AND section LIKE $3`,
    [specId, ownerId, `${division} %`]
  );
  const row = result.rows[0];
  if (!row) {
    throw new DivisionGeneralSpecNotInScopeError(
      `spec ${specId} is not in ${scope} ${ownerId} division ${division}`
    );
  }
  return row;
}

async function upsertManual(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  input: { readonly specId: string | null; readonly notes?: string },
  db: Queryable
): Promise<void> {
  const ownerField = ownerColumn(scope);
  const status = input.specId === null ? 'not_applicable' : 'resolved';
  await db.query(
    `INSERT INTO division_general_specs
       (${ownerField}, division, general_spec_id, status, detection_method, notes)
     VALUES ($1, $2, $3, $4, 'manual', $5)
     ON CONFLICT (${ownerField}, division) WHERE ${ownerField} IS NOT NULL
     DO UPDATE SET general_spec_id = EXCLUDED.general_spec_id,
                   status = EXCLUDED.status,
                   detection_method = 'manual',
                   notes = EXCLUDED.notes,
                   updated_at = now()`,
    [ownerId, division, input.specId, status, input.notes ?? null]
  );
}

function manualInput(
  specId: string | null,
  notes: string | undefined
): { readonly specId: string | null; readonly notes?: string } {
  return notes === undefined ? { specId } : { specId, notes };
}

async function setDivisionGeneralSpec(
  scope: DivisionGeneralScope,
  ownerId: string,
  division: string,
  input: SetDivisionGeneralSpecInput,
  db: Queryable = pool
): Promise<DivisionGeneralSpecResult> {
  try {
    if (!(await ownerExists(scope, ownerId, db))) {
      throw new DivisionGeneralOwnerNotFoundError(`${scope} ${ownerId} not found`);
    }
    if (input.generalSpecId) {
      const spec = await findSpecInScope(scope, ownerId, division, input.generalSpecId, db);
      await upsertManual(scope, ownerId, division, manualInput(spec.id, input.notes), db);
    } else {
      await upsertManual(scope, ownerId, division, manualInput(null, input.notes), db);
    }
    const result = await getDivisionGeneralSpec(scope, ownerId, division, db);
    if (!result) throw new DivisionGeneralOwnerNotFoundError(`${scope} ${ownerId} not found`);
    return result;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`setDivisionGeneralSpec failed for ${scope} ${ownerId}`, {
      cause: err,
    });
  }
}

export async function reconcileLibraryDivisionGeneralSpec(
  libraryId: string,
  section: string,
  db: Queryable = pool
): Promise<void> {
  const division = divisionOf(section);
  if (division === null) return;
  const exact = await findExactSpec('library', libraryId, division, db);
  if (exact) await upsertExactConfig('library', libraryId, division, exact.id, db);
}

export async function reconcileProjectDivisionGeneralSpec(
  projectId: string,
  section: string,
  db: Queryable = pool
): Promise<void> {
  const division = divisionOf(section);
  if (division === null) return;
  const exact = await findExactSpec('project', projectId, division, db);
  if (exact) await upsertExactConfig('project', projectId, division, exact.id, db);
}

export async function getLibraryDivisionGeneralSpec(
  libraryId: string,
  division: string,
  db: Queryable = pool
): Promise<DivisionGeneralSpecResult | null> {
  return getDivisionGeneralSpec('library', libraryId, division, db);
}

export async function getProjectDivisionGeneralSpec(
  projectId: string,
  division: string,
  db: Queryable = pool
): Promise<DivisionGeneralSpecResult | null> {
  return getDivisionGeneralSpec('project', projectId, division, db);
}

export async function setLibraryDivisionGeneralSpec(
  libraryId: string,
  division: string,
  input: SetDivisionGeneralSpecInput,
  db: Queryable = pool
): Promise<DivisionGeneralSpecResult> {
  return setDivisionGeneralSpec('library', libraryId, division, input, db);
}

export async function setProjectDivisionGeneralSpec(
  projectId: string,
  division: string,
  input: SetDivisionGeneralSpecInput,
  db: Queryable = pool
): Promise<DivisionGeneralSpecResult> {
  return setDivisionGeneralSpec('project', projectId, division, input, db);
}
