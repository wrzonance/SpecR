import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

// The unit project's worker ceiling. 4 is the issue's own verified-reliable
// value on the 24-core reproduction host, but Vitest takes an explicit
// maxWorkers verbatim — resolveMaxWorkers() applies no CPU clamp of its own —
// so a bare 4 would *raise* parallelism on a small runner (a 2-CPU host
// defaults to max(cpus - 1, 1) = 1 worker). Deriving the cap keeps this a
// ceiling everywhere: never above 4, and never above what Vitest would have
// chosen unaided.
const UNIT_MAX_WORKERS = Math.min(4, Math.max(availableParallelism() - 1, 1));

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
          // Seeds placeholder DATABASE_URL/NODE_ENV (#472) before any test
          // file's imports run, so src/lib/env.ts's import-time validation
          // never process.exit(1)s the no-DB unit suite when those vars
          // aren't already set in the shell.
          setupFiles: ['./src/test-utils/unit-env-setup.ts'],
          // Caps concurrent Vitest worker processes for the unit project.
          // Default (unbounded) worker count oversubscribes CPU on shared/
          // contended machines (e.g. several parallel workflows on one
          // sandbox), which starves fully-mocked, no-I/O tests of scheduler
          // time and trips Vitest's 5s default testTimeout — not a slow
          // test, pure CPU contention. Reproduced: under induced contention,
          // unbounded workers timed out 14-28 tests per run across many
          // unrelated files; --maxWorkers=4 held at 243/243 across repeated
          // runs under the same contention. See issue #612 (root cause
          // distinct from #608's integration hookTimeout, which stays
          // untouched) and UNIT_MAX_WORKERS above for why the cap is derived
          // from the host's CPU count rather than hardcoded to 4.
          maxWorkers: UNIT_MAX_WORKERS,
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
          // Forces NODE_ENV=test before any test file's imports run, so an
          // ambient NODE_ENV=development (common in a developer's shell, or
          // a manually sourced .env — see CLAUDE.md) can't re-arm the rate
          // limiter (ADR-046) mid-run. Unlike unit-env-setup.ts, never
          // touches DATABASE_URL: this project runs against a real
          // PostgreSQL instance. See #442.
          setupFiles: ['./src/test-utils/integration-env-setup.ts'],
          // Serialize integration test files — they share a single PostgreSQL
          // instance and otherwise race on FK constraints + unique keys.
          // Vitest 4: `fileParallelism: false` replaces v3's
          // `pool: 'forks' + poolOptions.forks.singleFork`. See issue #73.
          //
          // This scopes to files WITHIN ONE Vitest invocation only — it does
          // nothing across two separate `pnpm test:integration` processes
          // pointed at the same DATABASE_URL, which still race on the shared
          // database. That cross-invocation case is handled separately, below,
          // by a session-level PostgreSQL advisory lock (ADR-090, #638).
          fileParallelism: false,
          // Serializes concurrent `pnpm test:integration` INVOCATIONS (not
          // files — see fileParallelism above) against the same DATABASE_URL,
          // via a session advisory lock held for the whole run. See ADR-090
          // and src/test-utils/integration-lock.global-setup.ts (#638).
          globalSetup: ['./src/test-utils/integration-lock.global-setup.ts'],
        },
      },
    ],
  },
});
