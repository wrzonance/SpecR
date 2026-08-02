import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      enabled: false,
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'json'],
      thresholds: { lines: 80, functions: 80, branches: 80 },
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/index.ts', // app bootstrap — covered by integration tests, not unit tests
        'src/api/router.ts', // pure wiring, no branch logic
        'src/db/migrations/**', // run by migration CLI, not test suite
        'src/db/seed.ts', // CLI script — run directly, not by test suite
        'src/test-utils/**', // test helpers — not production code
      ],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // scripts/ is included so repo-owned CI gates (e.g. check-node-pin,
          // ADR-081) carry regression tests like any other code.
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          testTimeout: 30_000,
          // Matches testTimeout. Vitest's hookTimeout defaults to 10s
          // independently of testTimeout, which is tight for beforeAll hooks
          // that parse+insert large fixtures (e.g. the 461-node 27_10_00.SEC
          // tree in src/parser/sec/index.integration.test.ts) under shared-
          // machine load. See issue #608.
          hookTimeout: 30_000,
          // Serialize integration test files — they share a single PostgreSQL
          // instance and otherwise race on FK constraints + unique keys.
          // Vitest 4: `fileParallelism: false` replaces v3's
          // `pool: 'forks' + poolOptions.forks.singleFork`. See issue #73.
          fileParallelism: false,
        },
      },
    ],
  },
});
