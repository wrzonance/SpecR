import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import type { LanguageRuleTerm, LanguageRules } from '../../ast/index.js';
import { resolveLanguageRulesForSpec } from './language-rule-profiles.js';
import { ProjectNotFoundError } from './derive.js';
import { PackageNotFoundError } from './packages.js';

// #411 / ADR-080 — the language-lint matching + scan engine. Resolution and
// storage live in language-rule-profiles.ts; this module only reads the
// already-merged LanguageRules for a spec (D5) and turns them into findings.

interface Queryable {
  query: Pool['query'];
}

export type LanguageFindingCategory = 'bannedTerm' | 'reinforcingWord' | 'partyVocabulary';

// Two shapes, not four (ADR-080 D7): the three per-term categories share
// `language_term_flagged` with `category` carried as a data field — they are
// genuinely the same operation (scan text, report a match) with a label, not
// three different operations. `requiredPhrases` gets its own shape because it
// is a whole-spec presence check (D8), never paragraph-located.
export type LanguageFinding =
  | {
      readonly type: 'language_term_flagged';
      readonly category: LanguageFindingCategory;
      readonly term: string;
      readonly suggestion: string | null;
      readonly specId: string;
      readonly section: string;
      readonly paragraphId: string;
      readonly matchedText: string;
    }
  | {
      readonly type: 'language_phrase_missing';
      readonly phrase: string;
      readonly suggestion: string | null;
      readonly specId: string;
      readonly section: string;
    };

export interface LanguageScanParagraph {
  readonly id: string;
  readonly specId: string;
  readonly section: string;
  readonly text: string;
}

export interface LanguageFindingsSummary {
  readonly bannedTerm: number;
  readonly reinforcingWord: number;
  readonly partyVocabulary: number;
  readonly phraseMissing: number;
  readonly total: number;
}

export interface LanguageFindingsReport {
  readonly projectId: string;
  readonly packageId: string | null;
  readonly configured: boolean;
  readonly findings: readonly LanguageFinding[];
  readonly summary: LanguageFindingsSummary;
  readonly notes: readonly string[];
}

/** Escapes every regex metacharacter in a literal term so it is matched as
 *  exact text, never interpreted as a pattern (e.g. "A.E." must not match
 *  "AXE" via an unescaped wildcard "."). */
export function escapeLiteralForRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ADR-080 D6 (spike correction — supersedes a pre-spike `\b`-wrap design):
 * a literal term is bounded with negative lookaround against an explicit
 * word-char class on both sides, NOT `\b`. `\b` only fires at a transition
 * between a word character and a non-word character, so a term whose own
 * edge character is already non-word ("A.E.", "A/E", "Owner's Rep.") never
 * produces that transition — `\b` would silently never match it. Lookaround
 * asserts only the neighboring character *outside* the match, independent of
 * the term's own edges, so it has no such failure mode. Do not "simplify"
 * this back to `\b` — see docs/adr/080-language-lint-profile.md D6.
 *
 * `isRegex: true` terms are used exactly as authored — no boundary wrapping.
 * A regex author owns their own boundaries; auto-wrapping would silently
 * change a pattern's meaning. An invalid pattern degrades to `null` here
 * (never throws) so one bad rule cannot take down a whole scan.
 */
export function buildTermMatcher(rule: LanguageRuleTerm): RegExp | null {
  if (rule.isRegex === true) {
    try {
      return new RegExp(rule.term, 'gi');
    } catch {
      return null;
    }
  }
  const escaped = escapeLiteralForRegex(rule.term);
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi');
}

function matchTermInText(text: string, term: LanguageRuleTerm): RegExpExecArray | null {
  const matcher = buildTermMatcher(term);
  return matcher ? matcher.exec(text) : null;
}

function toTermFlaggedFinding(
  p: LanguageScanParagraph,
  term: LanguageRuleTerm,
  category: LanguageFindingCategory,
  match: RegExpExecArray
): LanguageFinding {
  return {
    type: 'language_term_flagged',
    category,
    term: term.term,
    suggestion: term.suggestion ?? null,
    specId: p.specId,
    section: p.section,
    paragraphId: p.id,
    matchedText: match[0] ?? term.term,
  };
}

/** One paragraph against one category's term list. A term with no match, or
 *  whose matcher degraded to `null` (invalid `isRegex` pattern), contributes
 *  no finding — it is skipped, never thrown (opt-in, ADR-080 D1/D6). */
export function scanParagraphForCategory(
  p: LanguageScanParagraph,
  terms: readonly LanguageRuleTerm[],
  category: LanguageFindingCategory
): readonly LanguageFinding[] {
  return terms.flatMap((term) => {
    const match = matchTermInText(p.text, term);
    return match ? [toTermFlaggedFinding(p, term, category, match)] : [];
  });
}

function toPhraseMissingFinding(
  specId: string,
  section: string,
  phrase: LanguageRuleTerm
): LanguageFinding {
  return {
    type: 'language_phrase_missing',
    phrase: phrase.term,
    suggestion: phrase.suggestion ?? null,
    specId,
    section,
  };
}

/**
 * ADR-080 D8 — a missing required phrase cannot be pinned to one paragraph:
 * it is a fact about the whole spec's concatenated scanned text, so this runs
 * once per spec over `allScannedText`, never once per paragraph. A phrase
 * whose matcher degrades to `null` is skipped (neither "present" nor
 * "missing" can be determined), matching scanParagraphForCategory's
 * degrade-not-throw behavior for the same failure mode.
 */
export function scanSpecForMissingPhrases(
  specId: string,
  section: string,
  allScannedText: string,
  phrases: readonly LanguageRuleTerm[]
): readonly LanguageFinding[] {
  return phrases.flatMap((phrase) => {
    const matcher = buildTermMatcher(phrase);
    if (!matcher) return [];
    return matcher.test(allScannedText) ? [] : [toPhraseMissingFinding(specId, section, phrase)];
  });
}

interface ScannedParagraphRow {
  readonly id: string;
  readonly section: string;
  readonly text: string;
}

/** ADR-080 D9 — suppressed content (`vanish = true`) was never meant to reach
 *  the owner and should not be linted as if it will; editorial notes
 *  (`node_type = 'note'`) are instructions to the spec writer, not contract
 *  language, so linting them against contract-language rules is a category
 *  error. Both are excluded at the source, not filtered after the fact. */
export async function loadScannableParagraphs(
  specId: string,
  db: Queryable
): Promise<readonly ScannedParagraphRow[]> {
  try {
    const result = await db.query<ScannedParagraphRow>(
      `SELECT p.id, s.section, p.text
       FROM paragraphs p
       JOIN specs s ON s.id = p.spec_id
       WHERE p.spec_id = $1 AND p.vanish = false AND p.node_type <> 'note'
       ORDER BY p.position`,
      [specId]
    );
    return result.rows;
  } catch (err) {
    throw new DatabaseError(`loadScannableParagraphs: query failed for spec ${specId}`, {
      cause: err,
    });
  }
}

interface PresentSpec {
  readonly specId: string;
  readonly section: string;
}

// Mirrors coordination.ts's assertScope — a project/package existence guard
// this report shares no code with coordination.ts to keep this module's own
// module-boundary error (ProjectNotFoundError/PackageNotFoundError, both
// already DB-module-scoped types) self-contained.
async function assertScope(
  projectId: string,
  packageId: string | undefined,
  db: Queryable
): Promise<void> {
  const proj = await db.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if ((proj.rowCount ?? 0) === 0) {
    throw new ProjectNotFoundError(`project ${projectId} not found`);
  }
  if (packageId !== undefined) {
    const pkg = await db.query(`SELECT 1 FROM design_packages WHERE id = $1 AND project_id = $2`, [
      packageId,
      projectId,
    ]);
    if ((pkg.rowCount ?? 0) === 0) {
      throw new PackageNotFoundError(`package ${packageId} not found in project ${projectId}`);
    }
  }
}

async function readPresentSpecs(
  projectId: string,
  packageId: string | undefined,
  db: Queryable
): Promise<readonly PresentSpec[]> {
  // ORDER BY is load-bearing, not cosmetic: without it Postgres may return the
  // same membership rows in a different order per request, and because
  // scanPresentSpecs preserves this order into the response, two identical
  // findings requests could report the same findings in a different sequence.
  // Ordering by the membership table's own `position` also makes the report
  // read in the project's / package's table-of-contents order; `s.id` breaks
  // any tie deterministically.
  const sql =
    packageId === undefined
      ? `SELECT s.id AS spec_id, s.section
         FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
         WHERE ps.project_id = $1 AND s.withdrawn_at IS NULL
         ORDER BY ps.position, s.id`
      : `SELECT s.id AS spec_id, s.section
         FROM package_specs ks JOIN specs s ON s.id = ks.spec_id
         WHERE ks.package_id = $1 AND s.withdrawn_at IS NULL
         ORDER BY ks.position, s.id`;
  const result = await db.query<{ spec_id: string; section: string }>(sql, [
    packageId ?? projectId,
  ]);
  return result.rows.map((row) => ({ specId: row.spec_id, section: row.section }));
}

interface SpecScanResult {
  readonly findings: readonly LanguageFinding[];
  readonly configured: boolean;
}

function scanParagraphsForTermCategories(
  paragraphs: readonly LanguageScanParagraph[],
  rules: LanguageRules
): readonly LanguageFinding[] {
  return [
    ...paragraphs.flatMap((p) =>
      scanParagraphForCategory(p, rules.bannedTerms ?? [], 'bannedTerm')
    ),
    ...paragraphs.flatMap((p) =>
      scanParagraphForCategory(p, rules.reinforcingWords ?? [], 'reinforcingWord')
    ),
    ...paragraphs.flatMap((p) =>
      scanParagraphForCategory(p, rules.partyVocabulary ?? [], 'partyVocabulary')
    ),
  ];
}

// A spec with zero resolved layers anywhere is not scanned at all (opt-in,
// ADR-080 D1) — `configured: false` lets the caller distinguish "scanned,
// nothing found" from "linting is off for this spec".
async function scanSpec(spec: PresentSpec, db: Queryable): Promise<SpecScanResult> {
  const resolved = await resolveLanguageRulesForSpec(spec.specId, db);
  if (resolved.layers.length === 0) return { findings: [], configured: false };

  const rows = await loadScannableParagraphs(spec.specId, db);
  const paragraphs: readonly LanguageScanParagraph[] = rows.map((row) => ({
    id: row.id,
    specId: spec.specId,
    section: row.section,
    text: row.text,
  }));
  const termFindings = scanParagraphsForTermCategories(paragraphs, resolved.rules);
  const allScannedText = rows.map((row) => row.text).join('\n');
  const phraseFindings = scanSpecForMissingPhrases(
    spec.specId,
    spec.section,
    allScannedText,
    resolved.rules.requiredPhrases ?? []
  );
  return { findings: [...termFindings, ...phraseFindings], configured: true };
}

async function scanPresentSpecs(
  present: readonly PresentSpec[],
  db: Queryable
): Promise<{ readonly findings: readonly LanguageFinding[]; readonly configured: boolean }> {
  const results = await Promise.all(present.map((spec) => scanSpec(spec, db)));
  return {
    findings: results.flatMap((r) => r.findings),
    configured: results.some((r) => r.configured),
  };
}

function countCategory(
  findings: readonly LanguageFinding[],
  category: LanguageFindingCategory
): number {
  return findings.filter((f) => f.type === 'language_term_flagged' && f.category === category)
    .length;
}

function summarize(findings: readonly LanguageFinding[]): LanguageFindingsSummary {
  return {
    bannedTerm: countCategory(findings, 'bannedTerm'),
    reinforcingWord: countCategory(findings, 'reinforcingWord'),
    partyVocabulary: countCategory(findings, 'partyVocabulary'),
    phraseMissing: findings.filter((f) => f.type === 'language_phrase_missing').length,
    total: findings.length,
  };
}

const NOT_CONFIGURED_NOTE =
  'no language-rule profile is configured for this project, its client library, or any ' +
  "present spec's authoring library — language linting is opt-in and off (ADR-080 D1)";

/**
 * Scan every present spec in a project (or one of its packages) against its
 * resolved language-rule layers (ADR-080 D5) and report the findings.
 * `configured` is false — with an explanatory note, no findings — only when
 * NOT ONE present spec resolved any layer anywhere in the chain; linting is
 * opt-in, so "nothing configured" is a normal, reportable state, not a 404.
 */
export async function getLanguageFindingsReport(
  projectId: string,
  packageId: string | undefined,
  db: Pool = pool
): Promise<LanguageFindingsReport> {
  try {
    await assertScope(projectId, packageId, db);
    const present = await readPresentSpecs(projectId, packageId, db);
    const { findings, configured } = await scanPresentSpecs(present, db);
    return {
      projectId,
      packageId: packageId ?? null,
      configured,
      findings,
      summary: summarize(findings),
      notes: configured ? [] : [NOT_CONFIGURED_NOTE],
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getLanguageFindingsReport failed for project ${projectId}`, {
      cause: err,
    });
  }
}
