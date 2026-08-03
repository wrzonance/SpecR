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
});
