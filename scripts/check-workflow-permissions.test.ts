import { describe, expect, it } from 'vitest';

import {
  claudeJobPermissions,
  extractJobPermissions,
  WorkflowPermissionsError,
} from './check-workflow-permissions.js';

describe('claude.yml job permissions', () => {
  // Regression (#600): pin the exact permission set granted to the `claude`
  // job so a future PR can't silently widen or narrow it. `id-token: write`
  // is KEPT deliberately — see check-workflow-permissions.ts's docblock —
  // even though the job's only steps are checkout + a third-party action,
  // because removing it without evidence the action doesn't use OIDC would
  // be an uncertain, silent auth change. A PR that legitimately changes this
  // set must update this test's expectation alongside it.
  it('grants exactly the reviewed permission set, including the deliberately-kept id-token: write', () => {
    expect(claudeJobPermissions()).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      issues: 'read',
      'id-token': 'write',
      actions: 'read',
    });
  });
});

describe('extractJobPermissions', () => {
  it('throws when the named job does not exist', () => {
    const yaml = ['jobs:', '  other:', '    permissions:', '      contents: read'].join('\n');
    expect(() => extractJobPermissions(yaml, 'claude')).toThrow(WorkflowPermissionsError);
    expect(() => extractJobPermissions(yaml, 'claude')).toThrow(/no "claude:" job found/);
  });

  it('throws when the job has no permissions block', () => {
    const yaml = ['jobs:', '  claude:', '    runs-on: ubuntu-latest'].join('\n');
    expect(() => extractJobPermissions(yaml, 'claude')).toThrow(/no "permissions:" block/);
  });

  it('stops reading entries once the block dedents', () => {
    const yaml = [
      'jobs:',
      '  claude:',
      '    permissions:',
      '      contents: read',
      '    steps:',
      '      - uses: actions/checkout@deadbeef',
    ].join('\n');
    expect(extractJobPermissions(yaml, 'claude')).toEqual({ contents: 'read' });
  });

  // Regression: the search for a job's `permissions:` block used to scan
  // forward across the REST of the file, not bounded to that job's own text —
  // so a job with no permissions block would silently inherit a later
  // sibling job's block instead of throwing.
  it('does not attribute a later sibling job permissions block to a job with none', () => {
    const yaml = [
      'jobs:',
      '  claude:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@deadbeef',
      '  other:',
      '    permissions:',
      '      contents: read',
      '      id-token: write',
    ].join('\n');
    expect(() => extractJobPermissions(yaml, 'claude')).toThrow(WorkflowPermissionsError);
    expect(() => extractJobPermissions(yaml, 'claude')).toThrow(/no "permissions:" block/);
  });

  it('reads the correct permissions when the named job itself has a block and a sibling follows', () => {
    const yaml = [
      'jobs:',
      '  claude:',
      '    permissions:',
      '      contents: read',
      '  other:',
      '    permissions:',
      '      contents: write',
      '      id-token: write',
    ].join('\n');
    expect(extractJobPermissions(yaml, 'claude')).toEqual({ contents: 'read' });
  });
});
