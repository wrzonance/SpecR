import { defineConfig } from 'vitest/config'

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
      ],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          env: {
            DATABASE_URL: 'postgres://specr:specr@localhost:5432/specr_test',
            NODE_ENV: 'test',
          },
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
})
