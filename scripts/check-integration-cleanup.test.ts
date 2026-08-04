import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALLOWLISTED_PATTERN_DELETE_FILES,
  IntegrationCleanupError,
  type CleanupViolation,
  findIntegrationCleanupViolations,
  scanFileForPatternDeletes,
} from './check-integration-cleanup.js';

const ROOT = join(import.meta.dirname, '..');

// Read (not statically imported) so a malformed baseline surfaces as a test
// failure with context, the same as any other fixture load in this repo.
const readBaseline = (): readonly CleanupViolation[] => {
  const raw = readFileSync(
    join(import.meta.dirname, 'check-integration-cleanup.baseline.json'),
    'utf8'
  );
  return JSON.parse(raw) as readonly CleanupViolation[];
};

describe('scanFileForPatternDeletes', () => {
  describe('flags a non-id-scoped DELETE', () => {
    it.each([
      ['a LIKE pattern', 'await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [x]);'],
      [
        'a hardcoded literal equality',
        "await pool.query(`DELETE FROM specs WHERE section = '99 00 00'`);",
      ],
      [
        'an IS NOT NULL sweep',
        'await pool.query(`DELETE FROM editing_conventions WHERE library_id IS NOT NULL`);',
      ],
      ['no WHERE clause at all', 'await pool.query(`DELETE FROM header_footer_configs`);'],
      [
        'a bound param on a non-id column',
        'await pool.query(`DELETE FROM libraries WHERE name = $1`, [name]);',
      ],
    ])('%s', (_label, snippet) => {
      const violations = scanFileForPatternDeletes('fixture.ts', snippet);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.reason).toBeTruthy();
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

  it('never reports a violation from an allowlisted file', () => {
    const violations = findIntegrationCleanupViolations(ROOT);
    const allowlistedHits = violations.filter((v) =>
      ALLOWLISTED_PATTERN_DELETE_FILES.has(v.filePath)
    );
    expect(allowlistedHits).toEqual([]);
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
  it('matches the checked-in baseline snapshot exactly', () => {
    const violations = findIntegrationCleanupViolations(ROOT);
    expect(violations).toEqual(readBaseline());
  });
});
