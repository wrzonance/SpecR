import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

// ─── Invariant: the #485 w:fldSimple traversal stays within the repo's
// enforced complexity ceiling (eslint.config.js: `complexity` 10,
// `sonarjs/cognitive-complexity` 10) ─────────────────────────────────────────
//
// Spike finding (plan decision 7): a three-branch terminal dispatch in
// collectRunsAndFields — a separate skip-check, w:fldSimple-terminal, and
// w:r-terminal guard-continue — measured complexity 11 / cognitive-complexity
// 14, over the cap. The shipped shape merges the two terminal guards into one
// (`key === 'w:r' || key === 'w:fldSimple'`) dispatching through a shared
// pushTerminalRun helper, which clears both ceilings.
//
// A behavioral test can't pin this: the three-branch shape is just as
// functionally correct, only more complex, so no functional-input/output
// assertion would ever fail if someone reintroduced it. This test runs the
// SAME two rules ESLint enforces, via the Linter API (not the full
// project-typed ESLint instance, which needs `projectService` and costs
// ~3s/invocation — see #485 spike notes) directly against both changed
// files' real source text, so a regression fails with the actual rule
// violation instead of only surfacing at `pnpm lint` time.
//
// MAX_COMPLEXITY mirrors eslint.config.js's `complexity`/
// `sonarjs/cognitive-complexity` settings (never stricter than the real
// constraint) — hardcoded rather than imported because eslint.config.js sits
// outside tsconfig's rootDir ("src"), same idiom as line-budget.test.ts's
// MAX_LINES.
const MAX_COMPLEXITY = 10;

const CHANGED_FILES = ['./header-footer-region.ts', './header-footer-field-recognition.ts'];

function lintErrors(relativePath: string): readonly string[] {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const code = readFileSync(path, 'utf8');
  const linter = new Linter();
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
        plugins: { sonarjs },
        rules: {
          complexity: ['error', MAX_COMPLEXITY],
          'sonarjs/cognitive-complexity': ['error', MAX_COMPLEXITY],
        },
      },
    ],
    relativePath
  );
  return messages
    .filter((message) => message.severity === 2)
    .map((message) => `${relativePath}:${message.line} ${message.ruleId}: ${message.message}`);
}

describe('header/footer w:fldSimple traversal — complexity ceiling (#485)', () => {
  it.each(CHANGED_FILES)(
    '%s stays within complexity <= 10 and cognitive-complexity <= 10',
    (relativePath) => {
      expect(lintErrors(relativePath)).toEqual([]);
    }
  );
});
