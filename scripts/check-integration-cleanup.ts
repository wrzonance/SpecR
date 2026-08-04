/**
 * Integration-test cleanup-pattern ratchet.
 *
 * #638/ADR-090 established `deleteCapturedFixtures` (`src/test-utils/
 * integration-fixture-cleanup.ts`) as the idiom for teardown: delete exactly
 * the rows a test captured at insert time, never a name/section/title
 * pattern that can also match — and destroy — a concurrent invocation's
 * fixtures. Several `*.integration.test.ts` files still teardown by pattern.
 *
 * ADR-090 already recorded a deliberate decision NOT to mass-rewrite every
 * one of them in one pass (proportionality over the advisory lock it added).
 * This gate does not re-litigate that call: it is a RATCHET against a
 * checked-in baseline snapshot (`check-integration-cleanup.baseline.json`),
 * not a hard zero-assert. A PR that introduces a NEW non-id-scoped `DELETE`
 * outside the baseline/allowlist fails; a PR that fixes one and shrinks the
 * violation set must update the baseline in the same PR — a deliberate,
 * reviewed acknowledgment either way.
 *
 * Not a standalone CLI (unlike `check-node-pin.ts`/`check-action-pins.ts`)
 * because there is no separate invocation point for it in CI: it runs
 * entirely through `check-integration-cleanup.test.ts`, which plain
 * `pnpm test` already exercises (`scripts/**\/*.test.ts` is in the unit
 * project's include glob).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export class IntegrationCleanupError extends Error {}

/** One `DELETE` statement this scan judged not to be id-scoped. */
export interface CleanupViolation {
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
  readonly reason: string;
}

/**
 * The individual `DELETE` statements where a name/prefix pattern is a
 * deliberate, reviewed choice rather than an oversight — see each file's own
 * inline ADR-090/#638 comments for why an id-scoped rewrite doesn't apply.
 * File paths are `/`-joined, relative to the repo root; each value holds the
 * exact statement snippets that were reviewed.
 *
 * Keyed to STATEMENTS, not whole files, on purpose: a file-level exclusion
 * would silently accept any future unrelated pattern — or whole-table — delete
 * added to the same file, which is precisely the class this gate exists to
 * catch. Adding a new pattern delete to an allowlisted file still fails the
 * ratchet until it is reviewed and listed here (or baselined).
 */
export const ALLOWLISTED_PATTERN_DELETES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'src/db/queries/libraries.integration.test.ts',
    new Set([
      `DELETE FROM specs WHERE section LIKE '99 77 %'`,
      `DELETE FROM projects WHERE name = 'lib-xor-test-project'`,
    ]) as ReadonlySet<string>,
  ],
]);

/** True when this exact statement snippet is a reviewed, allowlisted delete. */
export const isAllowlistedPatternDelete = (filePath: string, snippet: string): boolean =>
  ALLOWLISTED_PATTERN_DELETES.get(filePath)?.has(snippet) ?? false;

// Captures a `DELETE FROM ...` SQL string, quote-delimited by backtick,
// single, or double quote — non-greedy up to the SAME delimiter, so a
// multi-line template-literal query (`DELETE FROM x\n WHERE ...`) is
// captured whole. Leading whitespace after the opening quote, any internal
// whitespace between DELETE and FROM, and any casing are all tolerated: a
// query written as `\n  delete\n  from x ...` is the same hazard as the
// one-line uppercase form, and a gate that only matched the tidy spelling
// would be bypassed by reformatting alone.
const DELETE_STATEMENT = /(`|'|")\s*(DELETE\s+FROM[\s\S]*?)\1/gi;

// A WHERE-clause comparison is id-scoped when it targets a column named
// "id" or ending "_id" and binds it to a query parameter, directly
// (`= $n` / `= ANY($n)`) or nested inside an id-scoped subquery
// (`x_id IN (SELECT id FROM ...)`) — never a hardcoded literal or pattern.
const ID_SCOPED_COMPARISON = /\b\w*_?id\s*(?:=\s*ANY\(\$\d+|=\s*\$\d+|IN\s*\(SELECT\s+id\s+FROM)/i;
const PATTERN_INDICATORS = /\bLIKE\b|=\s*'[^']*'|IS\s+NOT\s+NULL/i;

/** Everything after the first `WHERE`, or `''` when the statement has none. */
const whereClauseOf = (statement: string): string => {
  const match = /\bWHERE\b([\s\S]*)$/i.exec(statement);
  return match?.[1] ?? '';
};

/**
 * True when some `OR` branch of the predicate is not itself id-scoped.
 *
 * `WHERE id = $1 OR name = $2` binds a param on both sides, so a whole-clause
 * token search sees an id comparison and calls it safe — while the second
 * branch can still delete rows the test never captured. Every branch has to
 * carry its own id scope. `AND` needs no such treatment: it only narrows.
 */
const hasUnscopedOrBranch = (whereClause: string): boolean =>
  whereClause.split(/\bOR\b/i).some((branch) => !ID_SCOPED_COMPARISON.test(branch));

/**
 * True when a captured `DELETE FROM ...` statement is NOT scoped to ids the
 * test captured itself: a whole-table wipe (no `WHERE`), a `LIKE` pattern, a
 * hardcoded literal equality, an `IS NOT NULL` sweep, an `OR` branch that
 * escapes the id scope, or simply no id-scoped comparison at all.
 */
const isPatternDelete = (statement: string): boolean => {
  if (!/\bWHERE\b/i.test(statement)) return true;
  if (PATTERN_INDICATORS.test(statement)) return true;
  return hasUnscopedOrBranch(whereClauseOf(statement));
};

const patternDeleteReason = (statement: string): string => {
  if (!/\bWHERE\b/i.test(statement)) return 'no WHERE clause — whole-table delete';
  if (/\bLIKE\b/i.test(statement)) return 'LIKE pattern, not a captured id';
  if (/IS\s+NOT\s+NULL/i.test(statement)) return 'IS NOT NULL sweep, not a captured id';
  if (/=\s*'[^']*'/.test(statement)) return 'hardcoded literal equality, not a captured id';
  const whereClause = whereClauseOf(statement);
  if (ID_SCOPED_COMPARISON.test(whereClause) && hasUnscopedOrBranch(whereClause)) {
    return 'an OR branch is not id-scoped';
  }
  return 'no id-scoped comparison (id = $n / id = ANY($n))';
};

interface CommentScanState {
  readonly cleanedLines: readonly string[];
  readonly inBlockComment: boolean;
}

/**
 * Blanks `//` line comments and `/* ... *\/` block comments (replacing their
 * text with nothing, preserving line numbers) so an inline comment that
 * QUOTES a pattern-delete for documentation (several files do, citing the
 * old #638 bug) is never mistaken for live code. Carries block-comment state
 * across lines via a fold, never a mutated loop variable.
 */
const stripComments = (fileText: string): string =>
  fileText
    .split('\n')
    .reduce<CommentScanState>(
      (state, line) => {
        const next = stripCommentFromLine(line, state.inBlockComment);
        return {
          cleanedLines: [...state.cleanedLines, next.text],
          inBlockComment: next.inBlockComment,
        };
      },
      { cleanedLines: [], inBlockComment: false }
    )
    .cleanedLines.join('\n');

interface LineCommentResult {
  readonly text: string;
  readonly inBlockComment: boolean;
}

const stripCommentFromLine = (line: string, inBlockComment: boolean): LineCommentResult => {
  if (inBlockComment) {
    const end = line.indexOf('*/');
    return end === -1
      ? { text: '', inBlockComment: true }
      : { text: line.slice(end + 2), inBlockComment: false };
  }
  if (/^\s*\/\//.test(line)) return { text: '', inBlockComment: false };
  const start = line.indexOf('/*');
  if (start === -1) return { text: line, inBlockComment: false };
  const end = line.indexOf('*/', start + 2);
  return end === -1
    ? { text: line.slice(0, start), inBlockComment: true }
    : { text: line.slice(0, start) + line.slice(end + 2), inBlockComment: false };
};

/**
 * Pure line-based(*) regex scan of one file's text for `DELETE` statements
 * not keyed on a captured id. Unaware of the allowlist — callers filter.
 *
 * (*) "Line-based" in the sense of no SQL/AST parser: it locates statements
 * by quote-delimiter matching and reports the 1-based line the statement
 * starts on, not a full-language parse.
 */
export const scanFileForPatternDeletes = (
  filePath: string,
  fileText: string
): readonly CleanupViolation[] => {
  const cleaned = stripComments(fileText);
  const violations: CleanupViolation[] = [];
  const pattern = new RegExp(DELETE_STATEMENT.source, DELETE_STATEMENT.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const statement = match[2] ?? '';
    if (!isPatternDelete(statement)) continue;
    // Report the line the DELETE keyword sits on, not the opening quote's:
    // the two differ once whitespace follows the quote. match[0] is exactly
    // quote + whitespace + statement + quote, so the statement's offset is
    // the match length minus the statement and its closing quote.
    const deleteOffset = match.index + (match[0].length - statement.length - 1);
    const line = cleaned.slice(0, deleteOffset).split('\n').length;
    const snippet = (statement.split('\n')[0] ?? '').trim().slice(0, 120);
    violations.push({ filePath, line, snippet, reason: patternDeleteReason(statement) });
  }
  return violations;
};

const listIntegrationTestFiles = (rootDir: string): readonly string[] => {
  let entries: string[];
  try {
    entries = readdirSync(rootDir, { recursive: true }) as string[];
  } catch (err) {
    throw new IntegrationCleanupError(`could not list ${rootDir}`, { cause: err });
  }
  return entries
    .filter((entry) => entry.endsWith('.integration.test.ts'))
    .map((entry) => join(rootDir, entry))
    .sort();
};

/**
 * Walks `rootDir` (pass the repo root) for every `src/**\/*.integration.test.ts`
 * file and returns the non-id-scoped `DELETE` statements found, excluding the
 * individually reviewed statements in `ALLOWLISTED_PATTERN_DELETES`. Every
 * file is scanned — allowlisting drops single statements, never whole files.
 * Throws `IntegrationCleanupError` only on a filesystem read failure — never
 * silently skips a file it can't read.
 */
export const findIntegrationCleanupViolations = (rootDir: string): readonly CleanupViolation[] => {
  const srcDir = join(rootDir, 'src');
  const violations: CleanupViolation[] = [];
  for (const absolutePath of listIntegrationTestFiles(srcDir)) {
    const relativePath = relative(rootDir, absolutePath).split(sep).join('/');

    let fileText: string;
    try {
      fileText = readFileSync(absolutePath, 'utf8');
    } catch (err) {
      throw new IntegrationCleanupError(`could not read ${relativePath}`, { cause: err });
    }
    violations.push(
      ...scanFileForPatternDeletes(relativePath, fileText).filter(
        (violation) => !isAllowlistedPatternDelete(violation.filePath, violation.snippet)
      )
    );
  }
  return violations;
};
