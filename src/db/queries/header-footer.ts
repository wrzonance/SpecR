import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { HeaderFooterCompositionSchema } from '../../ast/index.js';
import type { HeaderFooterComposition } from '../../ast/index.js';

interface Queryable {
  query: Pool['query'];
}

export class HeaderFooterValidationError extends DatabaseError {}

export class HeaderFooterScopeError extends DatabaseError {}

export interface HeaderFooterScopeInput {
  readonly clientLibraryId?: string;
  readonly projectId?: string;
  readonly packageId?: string;
  readonly revisionId?: string;
}

export type HeaderFooterScope =
  | { readonly kind: 'client'; readonly clientLibraryId: string }
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'package'; readonly packageId: string }
  | { readonly kind: 'revision'; readonly revisionId: string };

export interface HeaderFooterConfig {
  readonly id: string;
  readonly scope: HeaderFooterScope;
  readonly config: HeaderFooterComposition;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ResolveHeaderFooterConfigInput {
  readonly projectId?: string;
  readonly packageId?: string;
  readonly revisionId?: string;
}

export interface HeaderFooterResolutionContext {
  readonly clientLibraryId: string | null;
  readonly projectId: string;
  readonly packageId?: string;
  readonly revisionId?: string;
}

export interface ResolvedHeaderFooterConfig {
  readonly context: HeaderFooterResolutionContext;
  readonly layers: readonly HeaderFooterConfig[];
  readonly config: HeaderFooterComposition;
}

interface HeaderFooterRow {
  readonly id: string;
  readonly client_library_id: string | null;
  readonly project_id: string | null;
  readonly package_id: string | null;
  readonly revision_id: string | null;
  readonly config: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ScopeTarget {
  readonly kind: HeaderFooterScope['kind'];
  readonly column: string;
  readonly value: string;
}

interface ResolutionContextRow {
  readonly client_library_id: string | null;
  readonly project_id: string;
  readonly package_id: string | null;
  readonly revision_id: string | null;
}

type JsonRecord = Record<string, unknown>;

const COLUMNS =
  'id, client_library_id, project_id, package_id, revision_id, config, created_at, updated_at';

function parseConfig(candidate: unknown, label: string): HeaderFooterComposition {
  const parsed = HeaderFooterCompositionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HeaderFooterValidationError(`header/footer config ${label} failed validation`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeUnknown(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? mergeUnknown(base[key], value) : value;
  }
  return merged;
}

function mergeConfigs(configs: readonly HeaderFooterComposition[]): HeaderFooterComposition {
  const merged = configs.reduce<unknown>((acc, config) => mergeUnknown(acc, config), {});
  return parseConfig(merged, 'resolution result');
}

function scopeTarget(scope: HeaderFooterScopeInput): ScopeTarget {
  const targets: ScopeTarget[] = [];
  if (scope.clientLibraryId) {
    targets.push({ kind: 'client', column: 'client_library_id', value: scope.clientLibraryId });
  }
  if (scope.projectId)
    targets.push({ kind: 'project', column: 'project_id', value: scope.projectId });
  if (scope.packageId)
    targets.push({ kind: 'package', column: 'package_id', value: scope.packageId });
  if (scope.revisionId) {
    targets.push({ kind: 'revision', column: 'revision_id', value: scope.revisionId });
  }
  if (targets.length !== 1) {
    throw new HeaderFooterScopeError('provide exactly one header/footer config scope');
  }
  const target = targets[0];
  if (!target) throw new HeaderFooterScopeError('provide a header/footer config scope');
  return target;
}

function mapScope(row: HeaderFooterRow): HeaderFooterScope {
  if (row.client_library_id) return { kind: 'client', clientLibraryId: row.client_library_id };
  if (row.project_id) return { kind: 'project', projectId: row.project_id };
  if (row.package_id) return { kind: 'package', packageId: row.package_id };
  if (row.revision_id) return { kind: 'revision', revisionId: row.revision_id };
  throw new HeaderFooterValidationError(`header/footer config ${row.id} has no scope`);
}

function mapRow(row: HeaderFooterRow): HeaderFooterConfig {
  return {
    id: row.id,
    scope: mapScope(row),
    config: parseConfig(row.config, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertClientLibrary(target: ScopeTarget, db: Queryable): Promise<void> {
  if (target.kind !== 'client') return;
  const result = await db.query<{ tier: string }>('SELECT tier FROM libraries WHERE id = $1', [
    target.value,
  ]);
  const row = result.rows[0];
  if (!row) throw new HeaderFooterScopeError(`client library ${target.value} not found`);
  if (row.tier !== 'client') {
    throw new HeaderFooterScopeError('header/footer client scope must target a client library');
  }
}

export async function upsertHeaderFooterConfig(
  scope: HeaderFooterScopeInput,
  config: unknown,
  db: Queryable = pool
): Promise<HeaderFooterConfig> {
  const target = scopeTarget(scope);
  const validated = parseConfig(config, 'write');
  try {
    await assertClientLibrary(target, db);
    const result = await db.query<HeaderFooterRow>(
      `INSERT INTO header_footer_configs (${target.column}, config)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (${target.column}) WHERE ${target.column} IS NOT NULL
       DO UPDATE SET config = EXCLUDED.config, updated_at = now()
       RETURNING ${COLUMNS}`,
      [target.value, JSON.stringify(validated)]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('upsertHeaderFooterConfig: no row returned');
    return mapRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`upsertHeaderFooterConfig: failed for ${target.kind}`, {
      cause: err,
    });
  }
}

export async function findHeaderFooterConfig(
  scope: HeaderFooterScopeInput,
  db: Queryable = pool
): Promise<HeaderFooterConfig | null> {
  const target = scopeTarget(scope);
  try {
    const result = await db.query<HeaderFooterRow>(
      `SELECT ${COLUMNS} FROM header_footer_configs WHERE ${target.column} = $1`,
      [target.value]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`findHeaderFooterConfig: query failed for ${target.kind}`, {
      cause: err,
    });
  }
}

export async function deleteHeaderFooterConfig(
  scope: HeaderFooterScopeInput,
  db: Queryable = pool
): Promise<boolean> {
  const target = scopeTarget(scope);
  try {
    const result = await db.query(`DELETE FROM header_footer_configs WHERE ${target.column} = $1`, [
      target.value,
    ]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    throw new DatabaseError(`deleteHeaderFooterConfig: failed for ${target.kind}`, {
      cause: err,
    });
  }
}

function resolutionScope(input: ResolveHeaderFooterConfigInput): ScopeTarget {
  const target = scopeTarget(input);
  if (target.kind === 'client') {
    throw new HeaderFooterScopeError(
      'resolve header/footer config from project, package, or revision'
    );
  }
  return target;
}

async function contextForProject(
  projectId: string,
  db: Queryable
): Promise<ResolutionContextRow | null> {
  const result = await db.query<ResolutionContextRow>(
    `SELECT p.id AS project_id, NULL::uuid AS package_id, NULL::uuid AS revision_id,
            client.library_id AS client_library_id
     FROM projects p
     LEFT JOIN LATERAL (
       SELECT ps.library_id
       FROM project_sources ps JOIN libraries l ON l.id = ps.library_id
       WHERE ps.project_id = p.id AND l.tier = 'client'
       ORDER BY ps.priority
       LIMIT 1
     ) client ON true
     WHERE p.id = $1`,
    [projectId]
  );
  return result.rows[0] ?? null;
}

async function contextForPackage(
  packageId: string,
  db: Queryable
): Promise<ResolutionContextRow | null> {
  const result = await db.query<ResolutionContextRow>(
    `SELECT dp.project_id, dp.id AS package_id, NULL::uuid AS revision_id,
            client.library_id AS client_library_id
     FROM design_packages dp
     LEFT JOIN LATERAL (
       SELECT ps.library_id
       FROM project_sources ps JOIN libraries l ON l.id = ps.library_id
       WHERE ps.project_id = dp.project_id AND l.tier = 'client'
       ORDER BY ps.priority
       LIMIT 1
     ) client ON true
     WHERE dp.id = $1`,
    [packageId]
  );
  return result.rows[0] ?? null;
}

async function contextForRevision(
  revisionId: string,
  db: Queryable
): Promise<ResolutionContextRow | null> {
  const result = await db.query<ResolutionContextRow>(
    `SELECT dp.project_id, dp.id AS package_id, pr.id AS revision_id,
            client.library_id AS client_library_id
     FROM package_revisions pr
     JOIN design_packages dp ON dp.id = pr.package_id
     LEFT JOIN LATERAL (
       SELECT ps.library_id
       FROM project_sources ps JOIN libraries l ON l.id = ps.library_id
       WHERE ps.project_id = dp.project_id AND l.tier = 'client'
       ORDER BY ps.priority
       LIMIT 1
     ) client ON true
     WHERE pr.id = $1`,
    [revisionId]
  );
  return result.rows[0] ?? null;
}

async function loadResolutionContext(
  target: ScopeTarget,
  db: Queryable
): Promise<ResolutionContextRow | null> {
  if (target.kind === 'project') return contextForProject(target.value, db);
  if (target.kind === 'package') return contextForPackage(target.value, db);
  if (target.kind === 'revision') return contextForRevision(target.value, db);
  return null;
}

function mapContext(row: ResolutionContextRow): HeaderFooterResolutionContext {
  return {
    clientLibraryId: row.client_library_id,
    projectId: row.project_id,
    ...(row.package_id ? { packageId: row.package_id } : {}),
    ...(row.revision_id ? { revisionId: row.revision_id } : {}),
  };
}

async function selectResolutionLayers(
  context: HeaderFooterResolutionContext,
  db: Queryable
): Promise<readonly HeaderFooterConfig[]> {
  const result = await db.query<HeaderFooterRow>(
    `SELECT ${COLUMNS}
     FROM header_footer_configs
     WHERE ($1::uuid IS NOT NULL AND client_library_id = $1)
        OR project_id = $2
        OR ($3::uuid IS NOT NULL AND package_id = $3)
        OR ($4::uuid IS NOT NULL AND revision_id = $4)
     ORDER BY CASE
       WHEN client_library_id IS NOT NULL THEN 1
       WHEN project_id IS NOT NULL THEN 2
       WHEN package_id IS NOT NULL THEN 3
       WHEN revision_id IS NOT NULL THEN 4
       ELSE 5
     END`,
    [
      context.clientLibraryId,
      context.projectId,
      context.packageId ?? null,
      context.revisionId ?? null,
    ]
  );
  return result.rows.map(mapRow);
}

export async function resolveHeaderFooterConfig(
  input: ResolveHeaderFooterConfigInput,
  db: Queryable = pool
): Promise<ResolvedHeaderFooterConfig | null> {
  const target = resolutionScope(input);
  try {
    const row = await loadResolutionContext(target, db);
    if (!row) return null;
    const context = mapContext(row);
    const layers = await selectResolutionLayers(context, db);
    return {
      context,
      layers,
      config: mergeConfigs(layers.map((layer) => layer.config)),
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`resolveHeaderFooterConfig: failed for ${target.kind}`, {
      cause: err,
    });
  }
}
