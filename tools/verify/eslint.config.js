import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

// Mirrors the repo root's eslint.config.js (see CLAUDE.md "Project overrides")
// so tools/verify holds to the same enforced bar, even though it's an
// isolated pnpm package with its own lockfile/node_modules.
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
      // routes/runs.ts's multer upload limit (10 MB) deliberately mirrors
      // src/api/parse.ts's own compressed-upload limit exactly, which is
      // itself over this rule's 8 MB default fileUploadSizeLimit — raise
      // the threshold to match rather than shrink a limit that's already
      // sized to the real API it re-uploads to.
      'sonarjs/content-length': ['error', { fileUploadSizeLimit: 10 * 1024 * 1024 }],
    },
  },
  // Test suites grow linearly with the number of cases — the 50-line function
  // cap and 400-line file cap are production-code guards, not meaningful here.
  {
    files: ['src/**/*.test.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
    },
  },
  // The boot entrypoint prints human-readable startup/failure diagnostics to
  // the terminal — this harness has no pino logger of its own (isolated
  // package, see errors.ts's docstring), so console is the intended output
  // mechanism here. Mirrors the root config's scripts/**/*.ts carve-out.
  {
    files: ['src/index.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
)
