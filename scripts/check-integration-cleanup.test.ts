import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALLOWLISTED_PATTERN_DELETES,
  IntegrationCleanupError,
  type CleanupViolation,
  findIntegrationCleanupViolations,
  isAllowlistedPatternDelete,
  scanFileForPatternDeletes,
} from './check-integration-cleanup.js';

const ROOT = join(import.meta.dirname, '..');

/** A baselined violation's identity: everything except `line`. */
type CleanupViolationIdentity = Omit<CleanupViolation, 'line'>;

// Read (not statically imported) so a malformed baseline surfaces as a test
// failure with context, the same as any other fixture load in this repo.
//
// The baseline stores identity ONLY — no `line`. It was dropped rather than
// carried along: the ratchet never compared it, so it silently went stale the
// moment any unrelated edit shifted a baselined statement, and a stale line
// number is worse than none because a reader trusts it. `snippet` is the
// durable locator, and a failing run reports live line numbers anyway.
const readBaseline = (): readonly CleanupViolationIdentity[] => {
  const raw = readFileSync(
    join(import.meta.dirname, 'check-integration-cleanup.baseline.json'),
    'utf8'
  );
  return JSON.parse(raw) as readonly CleanupViolationIdentity[];
};

describe('scanFileForPatternDeletes', () => {
  describe('flags a non-id-scoped DELETE', () => {
    // Each case asserts the EXACT reason, not merely that one exists: the reason
    // is what a failing CI run shows the author, and `toBeTruthy()` would pass
    // even if every branch collapsed onto one generic string, hiding a
    // misclassification (a whole-table wipe reported as "no id-scoped
    // comparison", say) behind a green diagnostic.
    it.each([
      [
        'a LIKE pattern',
        'await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [x]);',
        'LIKE pattern, not a captured id',
      ],
      [
        'a hardcoded literal equality',
        "await pool.query(`DELETE FROM specs WHERE section = '99 00 00'`);",
        'hardcoded literal equality, not a captured id',
      ],
      [
        'an IS NOT NULL sweep',
        'await pool.query(`DELETE FROM editing_conventions WHERE library_id IS NOT NULL`);',
        'IS NOT NULL sweep, not a captured id',
      ],
      [
        'no WHERE clause at all',
        'await pool.query(`DELETE FROM header_footer_configs`);',
        'no WHERE clause — whole-table delete',
      ],
      [
        'a bound param on a non-id column',
        'await pool.query(`DELETE FROM libraries WHERE name = $1`, [name]);',
        'no id-scoped comparison (id = $n / id = ANY($n))',
      ],
      // Regression: ID_SCOPED_COMPARISON's column part was `\w*_?id`, whose
      // `\w*` swallowed the leading characters of ANY word merely ending in
      // "id" — so `valid`, `paid`, `grid` and `overrid` all read as id-scoped
      // and passed. `WHERE valid = $1` is a boolean flag that can match
      // arbitrarily many rows: the precise unscoped sweep this gate exists to
      // catch, waved through by the check itself.
      [
        'a bound param on a boolean column ending in "id" (valid)',
        'await pool.query(`DELETE FROM specs WHERE valid = $1`, [flag]);',
        'no id-scoped comparison (id = $n / id = ANY($n))',
      ],
      [
        'a bound param on another id-suffixed non-id column (paid)',
        'await pool.query(`DELETE FROM invoices WHERE paid = $1`, [flag]);',
        'no id-scoped comparison (id = $n / id = ANY($n))',
      ],
    ])('%s', (_label, snippet, expectedReason) => {
      const violations = scanFileForPatternDeletes('fixture.ts', snippet);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.reason).toBe(expectedReason);
    });

    // Regression: a multi-line template-literal query's WHERE clause lives on
    // a LATER line than `DELETE FROM` — a naive single-line scan would find
    // no WHERE on the DELETE FROM line and either miss the LIKE entirely or
    // misreport it as a whole-table wipe. The quote-delimited multi-line
    // capture must see the whole statement.
    it('a multi-line statement whose LIKE clause is on a later line', () => {
      const snippet = [
        'await pool.query(',
        '  `DELETE FROM package_revisions',
        '   WHERE package_id IN (SELECT id FROM design_packages WHERE name LIKE $1)`,',
        '  [prefix]',
        ');',
      ].join('\n');
      const violations = scanFileForPatternDeletes('fixture.ts', snippet);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.line).toBe(2);
    });

    // Regression: the gate must not be defeated by reformatting alone. A
    // pattern sweep written across lines, in lowercase, or with the DELETE
    // keyword pushed off the opening quote is the same hazard as the tidy
    // one-line uppercase spelling, and must land on the DELETE keyword's line.
    it.each([
      ['leading whitespace after the opening quote', '`  DELETE FROM specs WHERE name LIKE $1`', 1],
      ['lowercase SQL', "'delete from specs where name like $1'", 1],
      ['DELETE and FROM split across lines', '`DELETE\n   FROM specs WHERE name LIKE $1`', 1],
      ['the statement starting on the line after the quote', '`\n  DELETE FROM specs`', 2],
    ])('%s', (_label, snippet, expectedLine) => {
      const violations = scanFileForPatternDeletes('fixture.ts', snippet);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.line).toBe(expectedLine);
    });

    // Regression: one id-scoped branch does not make the predicate safe —
    // the OR branch can still delete rows the test never captured.
    it('an OR branch that is not id-scoped', () => {
      const violations = scanFileForPatternDeletes(
        'fixture.ts',
        "await pool.query('DELETE FROM specs WHERE id = $1 OR title = $2', [id, title]);"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.reason).toBe('an OR branch is not id-scoped');
    });
  });

  describe('does not flag an id-scoped DELETE', () => {
    it.each([
      ['id = $n', "await pool.query('DELETE FROM projects WHERE id = $1', [id]);"],
      ['id = ANY($n)', "await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [ids]);"],
      [
        'a foreign-key column = $n',
        "await pool.query('DELETE FROM specs WHERE project_id = $1', [projectId]);",
      ],
      [
        'a foreign-key column = ANY($n)',
        "await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [projectIds]);",
      ],
      [
        'a nested id-scoped subquery',
        "await pool.query('DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE project_id = ANY($1))', [ids]);",
      ],
      [
        'every OR branch id-scoped',
        "await pool.query('DELETE FROM specs WHERE library_id = ANY($1::uuid[]) OR project_id = $2', [ids, id]);",
      ],
    ])('%s', (_label, snippet) => {
      expect(scanFileForPatternDeletes('fixture.ts', snippet)).toHaveLength(0);
    });

    // Regression: several files quote the OLD pattern-delete inline, in a
    // comment, to document why it was replaced (#638/ADR-090) — e.g.
    // specs.integration.test.ts:18. A scan blind to comments would flag the
    // documentation itself as a live violation.
    it('a // comment that quotes a pattern-delete for documentation', () => {
      const snippet = [
        "// hook ran `DELETE FROM specs WHERE section = '99 00 00'` — a pattern",
        '// match that also deleted concurrent fixtures (#638, ADR-090).',
        "await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [ids]);",
      ].join('\n');
      expect(scanFileForPatternDeletes('fixture.ts', snippet)).toHaveLength(0);
    });

    // Regression: this scanner finds `/*` by position and knows nothing about
    // string literals, so a `/*` inside a quoted string opens a block comment
    // it never meant to open — blanking every following line, and with them
    // any live DELETE. That is a SILENT BYPASS, not a false positive: the gate
    // would report zero violations and pass. Unbalanced markers cannot occur
    // in a file that compiles, so reaching EOF still inside a block comment
    // means the scan is untrustworthy and must fail loudly rather than return
    // a partially-blanked file.
    it('throws when a file ends still inside a block comment, instead of silently blanking it', () => {
      const snippet = [
        "const marker = 'a /* b';",
        'await pool.query(`DELETE FROM header_footer_configs`);',
      ].join('\n');
      expect(() => scanFileForPatternDeletes('fixture.ts', snippet)).toThrow(
        IntegrationCleanupError
      );
      expect(() => scanFileForPatternDeletes('fixture.ts', snippet)).toThrow(
        /still inside a block comment/
      );
    });

    // Regression: a JSDoc block comment can also quote a pattern-delete
    // inline, e.g. contract-write-response.integration.test.ts:88.
    it('a /** */ block comment that quotes a pattern-delete for documentation', () => {
      const snippet = [
        '/** delete_package hard-deletes (`DELETE FROM design_packages`), so the',
        ' * row is gone already — no id-scoped teardown needed here. */',
        "await pool.query('DELETE FROM projects WHERE id = $1', [id]);",
      ].join('\n');
      expect(scanFileForPatternDeletes('fixture.ts', snippet)).toHaveLength(0);
    });
  });
});

describe('findIntegrationCleanupViolations', () => {
  it('throws IntegrationCleanupError with cause chained when rootDir cannot be read', () => {
    const bogusRoot = join(ROOT, 'this-directory-does-not-exist-442');
    expect(() => findIntegrationCleanupViolations(bogusRoot)).toThrow(IntegrationCleanupError);
    try {
      findIntegrationCleanupViolations(bogusRoot);
      expect.unreachable('expected findIntegrationCleanupViolations to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationCleanupError);
      expect((err as IntegrationCleanupError).cause).toBeDefined();
    }
  });

  it('never reports an allowlisted statement', () => {
    const violations = findIntegrationCleanupViolations(ROOT);
    const allowlistedHits = violations.filter((v) => isAllowlistedPatternDelete(v.filePath, v.snippet));
    expect(allowlistedHits).toEqual([]);
  });

  // Regression: allowlisting is keyed to reviewed STATEMENTS, not whole
  // files. A file-level exclusion would silently accept any future unrelated
  // sweep — including a whole-table wipe — added to the same file.
  it('still reports a NON-allowlisted delete inside an allowlisted file', () => {
    const [allowlistedFile] = [...ALLOWLISTED_PATTERN_DELETES.keys()];
    expect(allowlistedFile).toBeDefined();
    const violations = scanFileForPatternDeletes(
      allowlistedFile as string,
      'await pool.query(`DELETE FROM header_footer_configs`);'
    );
    expect(violations).toHaveLength(1);
    expect(isAllowlistedPatternDelete(violations[0]!.filePath, violations[0]!.snippet)).toBe(false);
  });

  // Runs unconditionally: pure filesystem scan, no DATABASE_URL, no seeded
  // fixtures, no `describe.runIf(existsSync(...))` gate — CI exercises this
  // via plain `pnpm test` (scripts/**/*.test.ts is already unit-included).
  it('runs with no DB/fixture dependency', () => {
    expect(() => findIntegrationCleanupViolations(ROOT)).not.toThrow();
  });

  // The ratchet itself: an exact match against the checked-in baseline, not
  // a bound. A newly introduced non-id-scoped DELETE outside the baseline/
  // allowlist changes this result and fails the test — the whole point of a
  // gate that ratchets instead of asserting zero. Shrinking the violation
  // set (a fix) is equally required to update the baseline in the same PR:
  // both directions are a deliberate, reviewed acknowledgment, never silent.
  //
  // Compared on IDENTITY — (filePath, snippet, reason) — deliberately
  // excluding `line`. A violation is the same violation whether it sits at
  // line 80 or line 180, and asserting on position would make this gate fail
  // for a reason that has nothing to do with cleanup hygiene: any unrelated
  // PR that adds or removes lines ABOVE a baselined DELETE would shift it and
  // turn this red. With several branches editing baselined files
  // concurrently, that is not hypothetical. Same reasoning as keying the
  // allowlist to statements rather than whole files.
  it('matches the checked-in baseline snapshot exactly', () => {
    const identity = (v: CleanupViolation): CleanupViolationIdentity => ({
      filePath: v.filePath,
      snippet: v.snippet,
      reason: v.reason,
    });
    const violations = findIntegrationCleanupViolations(ROOT);
    expect(violations.map(identity)).toEqual(readBaseline());
  });
});
