import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { LanguageRulesSchema } from '../../ast/index.js';
import type { LanguageRules, LanguageRuleTerm } from '../../ast/index.js';
import { checkRegexPatterns } from '../../lib/regex-safety.js';

// #411 / ADR-080 — CRUD + resolution for a firm's language-rule profiles.
// Scope mirrors division_general_specs (migration 022/053): exactly one of
// library_id/project_id per row, enforced by the DB's owner-XOR CHECK. This
// module never seeds default content (ADR-080 D1) — an unconfigured scope
// lints nothing.

/** Raised when a language-rule write carries an oversized or unsafe regex (ADR-080 D6). */
export class LanguageRuleValidationError extends DatabaseError {}

/** Raised when a write targets a scope whose owner (library/project) does not exist. */
export class LanguageRuleScopeError extends DatabaseError {}

export type LanguageRuleScopeKind = 'library' | 'project';

export interface LanguageRuleScope {
  readonly scope: LanguageRuleScopeKind;
  readonly ownerId: string;
}

export interface LanguageRuleProfile {
  readonly id: string;
  readonly scope: LanguageRuleScopeKind;
  readonly ownerId: string;
  readonly rules: LanguageRules;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The applicable layers for one spec (broadest to narrowest, ADR-080 D5) plus
 * the already-merged rule set. `layers` is never longer than 3: the authoring
 * library, that project's client library (D3's single conditional hop), and
 * the project's own profile — each present only when configured.
 */
export interface ResolvedLanguageRules {
  readonly layers: readonly LanguageRuleProfile[];
  readonly rules: LanguageRules;
}

interface Queryable {
  query: Pool['query'];
}

interface LanguageRuleProfileRow {
  readonly id: string;
  readonly library_id: string | null;
  readonly project_id: string | null;
  readonly rules: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = 'id, library_id, project_id, rules, created_at, updated_at';

function mapRow(row: LanguageRuleProfileRow): LanguageRuleProfile {
  const ownerId = row.library_id ?? row.project_id;
  if (ownerId === null) {
    // The DB's owner-XOR CHECK (migration 053) should make this unreachable;
    // guarded anyway so a malformed row surfaces loudly, never silently.
    throw new DatabaseError('language_rule_profiles row violates the owner XOR constraint');
  }
  return {
    id: row.id,
    scope: row.library_id !== null ? 'library' : 'project',
    ownerId,
    rules: LanguageRulesSchema.parse(row.rules),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ownerColumn(scope: LanguageRuleScopeKind): 'library_id' | 'project_id' {
  return scope === 'library' ? 'library_id' : 'project_id';
}

function ownerTable(scope: LanguageRuleScopeKind): 'libraries' | 'projects' {
  return scope === 'library' ? 'libraries' : 'projects';
}

function regexTermsIn(terms: readonly LanguageRuleTerm[] | undefined): readonly string[] {
  return (terms ?? []).filter((term) => term.isRegex === true).map((term) => term.term);
}

// Every isRegex:true term across all 4 categories, flattened for one bounds
// check. Literal terms never appear here — they are always escaped before use
// (src/db/queries/language-rule-findings.ts), never interpreted as regex
// syntax, so they carry no ReDoS risk and are deliberately left unbounded in
// count/length (ADR-080 "Negative" consequences — a conscious v1 trade-off).
function allRegexTerms(rules: LanguageRules): readonly string[] {
  return [
    ...regexTermsIn(rules.bannedTerms),
    ...regexTermsIn(rules.reinforcingWords),
    ...regexTermsIn(rules.partyVocabulary),
    ...regexTermsIn(rules.requiredPhrases),
  ];
}

/**
 * Write boundary: shape-validate against LanguageRulesSchema, then bound every
 * isRegex:true term's pattern across all four categories with the shared
 * ReDoS/length/count guard (ADR-080 D6). Captured facts are never rejected;
 * unsafe regex authoring is.
 */
export function validateRules(rules: LanguageRules): LanguageRules {
  const parsed = LanguageRulesSchema.parse(rules);
  const safety = checkRegexPatterns(allRegexTerms(parsed));
  if (!safety.safe) {
    throw new LanguageRuleValidationError(`unsafe language rule regex: ${safety.reason}`);
  }
  return parsed;
}

async function assertOwnerExists(scope: LanguageRuleScope, db: Queryable): Promise<void> {
  const result = await db.query(`SELECT 1 FROM ${ownerTable(scope.scope)} WHERE id = $1`, [
    scope.ownerId,
  ]);
  if ((result.rowCount ?? 0) === 0) {
    throw new LanguageRuleScopeError(`${scope.scope} ${scope.ownerId} not found`);
  }
}

/**
 * Create or replace a scope's language-rule profile (PUT semantics). One row
 * per library/project, enforced by migration 053's partial unique indexes, so
 * the write is a single atomic upsert — concurrent PUTs for the same scope
 * converge instead of racing into a unique-violation 500 (same pattern as
 * upsertLibraryConvention).
 */
export async function upsertLanguageRuleProfile(
  scope: LanguageRuleScope,
  rules: LanguageRules,
  db: Queryable = pool
): Promise<LanguageRuleProfile> {
  const validated = validateRules(rules);
  const col = ownerColumn(scope.scope);
  try {
    await assertOwnerExists(scope, db);
    const result = await db.query<LanguageRuleProfileRow>(
      `INSERT INTO language_rule_profiles (${col}, rules)
       VALUES ($1, $2)
       ON CONFLICT (${col}) WHERE ${col} IS NOT NULL
       DO UPDATE SET rules = EXCLUDED.rules, updated_at = now()
       RETURNING ${COLUMNS}`,
      [scope.ownerId, JSON.stringify(validated)]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('upsertLanguageRuleProfile: no row returned');
    return mapRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `upsertLanguageRuleProfile: failed for ${scope.scope} ${scope.ownerId}`,
      { cause: err }
    );
  }
}

/** Read-path: no owner-existence check (an unconfigured or non-existent scope
 *  both resolve to null) — the distinction only matters on write. */
export async function findLanguageRuleProfile(
  scope: LanguageRuleScope,
  db: Queryable = pool
): Promise<LanguageRuleProfile | null> {
  const col = ownerColumn(scope.scope);
  try {
    const result = await db.query<LanguageRuleProfileRow>(
      `SELECT ${COLUMNS} FROM language_rule_profiles WHERE ${col} = $1`,
      [scope.ownerId]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  } catch (err) {
    throw new DatabaseError(
      `findLanguageRuleProfile: query failed for ${scope.scope} ${scope.ownerId}`,
      { cause: err }
    );
  }
}

export async function deleteLanguageRuleProfile(
  scope: LanguageRuleScope,
  db: Queryable = pool
): Promise<boolean> {
  const col = ownerColumn(scope.scope);
  try {
    const result = await db.query(`DELETE FROM language_rule_profiles WHERE ${col} = $1`, [
      scope.ownerId,
    ]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    throw new DatabaseError(
      `deleteLanguageRuleProfile: failed for ${scope.scope} ${scope.ownerId}`,
      { cause: err }
    );
  }
}

interface AuthoringLibraryRow {
  readonly authoring_library_id: string | null;
}

/**
 * ADR-080 D4 — a project-copy spec (specs.parent_spec_id set) must still see
 * its originating master's library rules, not only its own project profile.
 * COALESCE picks the spec's own library_id when it IS a master (library_id
 * set); otherwise it falls back to the parent master's library_id. Spike-
 * verified against both shapes. Returns null when neither resolves (e.g. an
 * unknown specId) — resolution degrades to "no library layer", never throws.
 */
async function resolveAuthoringLibraryId(specId: string, db: Queryable): Promise<string | null> {
  try {
    const result = await db.query<AuthoringLibraryRow>(
      `SELECT COALESCE(s.library_id, master.library_id) AS authoring_library_id
       FROM specs s
       LEFT JOIN specs master ON master.id = s.parent_spec_id
       WHERE s.id = $1`,
      [specId]
    );
    return result.rows[0]?.authoring_library_id ?? null;
  } catch (err) {
    throw new DatabaseError(`resolveAuthoringLibraryId: query failed for spec ${specId}`, {
      cause: err,
    });
  }
}

async function resolveSpecProjectId(specId: string, db: Queryable): Promise<string | null> {
  try {
    const result = await db.query<{ project_id: string | null }>(
      `SELECT project_id FROM specs WHERE id = $1`,
      [specId]
    );
    return result.rows[0]?.project_id ?? null;
  } catch (err) {
    throw new DatabaseError(`resolveSpecProjectId: query failed for spec ${specId}`, {
      cause: err,
    });
  }
}

/**
 * ADR-080 D3 — a single conditional hop: projects.client_id -> clients.id ->
 * clients.library_id. Never a recursive walk: a client cannot itself have a
 * parent client, so this join terminates after one hop by construction, not a
 * depth guard. Null when the project has no client, or its client has no
 * library.
 */
async function resolveProjectClientLibraryId(
  projectId: string,
  db: Queryable
): Promise<string | null> {
  try {
    const result = await db.query<{ library_id: string | null }>(
      `SELECT c.library_id
       FROM projects p
       JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1`,
      [projectId]
    );
    return result.rows[0]?.library_id ?? null;
  } catch (err) {
    throw new DatabaseError(
      `resolveProjectClientLibraryId: query failed for project ${projectId}`,
      {
        cause: err,
      }
    );
  }
}

// The (at most 3) scopes that apply to a spec, broadest to narrowest, each
// included only when it resolves to something real. Order here is what makes
// mergeLanguageRules' "narrowest wins" deterministic.
async function buildResolutionScopes(
  specId: string,
  db: Queryable
): Promise<readonly LanguageRuleScope[]> {
  const [authoringLibraryId, projectId] = await Promise.all([
    resolveAuthoringLibraryId(specId, db),
    resolveSpecProjectId(specId, db),
  ]);
  const clientLibraryId = projectId ? await resolveProjectClientLibraryId(projectId, db) : null;

  const scopes: LanguageRuleScope[] = [];
  if (authoringLibraryId) scopes.push({ scope: 'library', ownerId: authoringLibraryId });
  if (clientLibraryId) scopes.push({ scope: 'library', ownerId: clientLibraryId });
  if (projectId) scopes.push({ scope: 'project', ownerId: projectId });
  return scopes;
}

/**
 * Resolve the merged, applicable language-rule set for a spec (ADR-080 D5):
 * the authoring library, that project's client library (if any), and the
 * project's own profile, broadest to narrowest. A spec with zero configured
 * layers anywhere — including one whose id does not resolve at all — returns
 * `{ layers: [], rules: {} }` rather than throwing: linting is opt-in (D1), so
 * "nothing configured" is success, not failure. Underlying query failures
 * still propagate as DatabaseError, chained from the failing helper — never
 * swallowed.
 */
export async function resolveLanguageRulesForSpec(
  specId: string,
  db: Queryable = pool
): Promise<ResolvedLanguageRules> {
  const scopes = await buildResolutionScopes(specId, db);
  const found = await Promise.all(scopes.map((scope) => findLanguageRuleProfile(scope, db)));
  const layers = found.filter((profile): profile is LanguageRuleProfile => profile !== null);
  return { layers, rules: mergeLanguageRules(layers) };
}

// Case-insensitive term text plus its matching mode: a literal "Owner" and a
// regex "Owner" are distinct rules, but "Owner" vs "owner" in the same mode
// collide — the narrowest (last) layer's entry wins the collision.
function dedupeKey(term: LanguageRuleTerm): string {
  return `${term.term.toLowerCase()}::${term.isRegex ?? false}`;
}

function mergeCategory<K extends keyof LanguageRules>(
  layers: readonly LanguageRuleProfile[],
  category: K
): readonly LanguageRuleTerm[] | undefined {
  const byKey = new Map<string, LanguageRuleTerm>();
  for (const layer of layers) {
    for (const term of layer.rules[category] ?? []) {
      byKey.set(dedupeKey(term), term);
    }
  }
  return byKey.size > 0 ? [...byKey.values()] : undefined;
}

/**
 * Additive merge across resolution layers (ADR-080 D5): every category is the
 * union of all layers' terms, broadest to narrowest. On a same-key collision
 * the narrowest layer's entry wins — e.g. a project's own suggestion text
 * overrides its library's for the same banned term — but a narrower layer
 * that adds one term never drops a broader layer's whole list. Pure: never
 * mutates `layers` or any layer's `rules`.
 */
export function mergeLanguageRules(layers: readonly LanguageRuleProfile[]): LanguageRules {
  const bannedTerms = mergeCategory(layers, 'bannedTerms');
  const reinforcingWords = mergeCategory(layers, 'reinforcingWords');
  const partyVocabulary = mergeCategory(layers, 'partyVocabulary');
  const requiredPhrases = mergeCategory(layers, 'requiredPhrases');
  return {
    ...(bannedTerms ? { bannedTerms } : {}),
    ...(reinforcingWords ? { reinforcingWords } : {}),
    ...(partyVocabulary ? { partyVocabulary } : {}),
    ...(requiredPhrases ? { requiredPhrases } : {}),
  };
}
