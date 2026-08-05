import { availableParallelism } from 'node:os';

import { describe, expect, it } from 'vitest';

import rootConfig from '../vitest.config.js';

// Boundary invariants for #612 (unit-project maxWorkers cap): the change must
// touch only the unit project block, never the integration project's own
// timeouts (#608) or serialization (#73). Reading the exported config object
// — rather than grepping the file's text — pins the invariant at the actual
// config Vitest loads, not at incidental formatting.
//
// Lives under scripts/ (not src/) because vitest.config.ts sits at the repo
// root, outside tsconfig.json's rootDir ("src") — importing it from a
// src/**/*.test.ts file trips TS6059. scripts/**/*.ts is already excluded
// from tsconfig.json and is included in the unit project's test glob.
const projects = rootConfig.test?.projects;
if (!projects || projects.length < 2) {
  throw new Error('vitest.config.ts: expected test.projects to have a unit and integration entry');
}

const [unitProject, integrationProject] = projects;
if (
  typeof unitProject !== 'object' ||
  typeof integrationProject !== 'object' ||
  unitProject instanceof Promise ||
  integrationProject instanceof Promise
) {
  throw new Error(
    'vitest.config.ts: expected inline project config objects, not config-file paths'
  );
}

describe('vitest.config.ts unit project', () => {
  it("does not override testTimeout, leaving Vitest's 5000ms default in force", () => {
    expect(unitProject.test?.testTimeout).toBeUndefined();
  });

  // Pins the actual #612 fix: capping the unit project's worker count so
  // fully-mocked, no-I/O tests don't get starved of scheduler time (and trip
  // Vitest's 5s default testTimeout) when CPU is oversubscribed by unrelated
  // parallel workflows on a shared/contended machine. Without this
  // assertion, a future edit that silently drops or changes maxWorkers would
  // leave CI green while the regression this issue fixes resurfaces.
  it('caps maxWorkers at 4 to avoid CPU-oversubscription timeouts (#612)', () => {
    expect(unitProject.test?.maxWorkers).toBeGreaterThanOrEqual(1);
    expect(unitProject.test?.maxWorkers).toBeLessThanOrEqual(4);
  });

  // The other half of "cap": Vitest applies an explicit maxWorkers verbatim
  // (resolveMaxWorkers() adds no CPU clamp), so a hardcoded ceiling that
  // exceeds the host's CPU count would *raise* parallelism on a small runner
  // — a 2-CPU host defaults to 1 worker — recreating the very contention this
  // issue fixes. Asserts the config can only ever reduce parallelism relative
  // to what Vitest would have chosen unaided, on whatever host runs the suite.
  it('never exceeds the CPU-aware default it replaces (#612)', () => {
    const vitestDefault = Math.max(availableParallelism() - 1, 1);
    expect(unitProject.test?.maxWorkers).toBeLessThanOrEqual(vitestDefault);
  });
});

describe('vitest.config.ts integration project', () => {
  // Pins the exact values #608/#73 established, so a future edit to the unit
  // project (e.g. this one, adding maxWorkers) cannot silently drift the
  // integration project's own timeout/serialization contract.
  it('keeps its #608/#73 settings unchanged by the #612 maxWorkers change', () => {
    expect(integrationProject.test).toMatchObject({
      name: 'integration',
      testTimeout: 30_000,
      hookTimeout: 30_000,
      fileParallelism: false,
    });
  });

  // Pins the #638 fix: without this assertion, deleting the globalSetup
  // entry (the entire cross-invocation advisory-lock mechanism, ADR-090)
  // from vitest.config.ts left every other assertion in this describe block
  // green.
  it('registers the ADR-090 advisory-lock globalSetup hook (#638)', () => {
    expect(integrationProject.test?.globalSetup).toEqual([
      './src/test-utils/integration-lock.global-setup.ts',
    ]);
  });

  // Pins the #442 fix: without this assertion, deleting the setupFiles
  // entry leaves an ambient NODE_ENV=development free to re-arm the rate
  // limiter (ADR-046) for `pnpm test:integration`, while every other
  // assertion in this describe block stays green.
  it('registers the NODE_ENV defense-in-depth setupFiles hook (#442)', () => {
    expect(integrationProject.test?.setupFiles).toEqual([
      './src/test-utils/integration-env-setup.ts',
    ]);
  });
});
