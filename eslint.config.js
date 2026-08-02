import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  sonarjs.configs.recommended,
  {
    rules: {
      complexity: ['error', 10],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'sonarjs/cognitive-complexity': ['error', 10],
    },
  },
  // In test files, vi.mocked(obj.method) is the standard pattern for mocking
  // instance methods. The method is always a vi.fn() at runtime, so the
  // unbound-method warning is a false positive here.
  // describe() callbacks and test suites grow linearly with the number of cases —
  // the 50-line function cap and 400-line file cap are production-code guards, not
  // meaningful for test suites.
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      // Integration tests use console.warn/info for fixture diagnostics — not production code.
      'no-console': 'off',
      // eslint-plugin-sonarjs 4.1 added these two as errors. Both are style
      // opinions about how assertions are written, not correctness checks:
      // `parameterized-tests` wants sibling `it()` cases collapsed into
      // `it.each`, which loses the individually-named regressions this repo
      // deliberately writes one-per-symptom; `prefer-specific-assertions`
      // wants `toHaveLength` over `.length` comparisons. Declining the new
      // opinions in tests — note this is opting out of newly-added rules, not
      // silencing a gate that ever caught a defect here.
      'sonarjs/parameterized-tests': 'off',
      'sonarjs/prefer-specific-assertions': 'off',
      // `sonarjs/no-floating-point-equality` stays ON: it would catch a real
      // comparison against computed float arithmetic. The few exact-equality
      // assertions in this repo compare against literal constants the source
      // sets directly and carry a targeted inline disable at the call site.
    },
  },
  // scripts/ are CLI entry points — console.log is the intended output mechanism.
  // They are excluded from tsconfig.json so type-checked rules don't apply.
  {
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
)
