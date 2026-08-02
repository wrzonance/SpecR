import { describe, expect, it } from 'vitest';

import {
  ActionPinError,
  checkAllWorkflowRefs,
  checkFile,
  extractUsesValues,
  parsePinnedActionRef,
} from './check-action-pins.js';

describe('parsePinnedActionRef', () => {
  it('accepts a commit-SHA pin with a trailing version comment', () => {
    const ref = parsePinnedActionRef(
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      'test'
    );
    expect(ref).toEqual({
      repo: 'actions/checkout',
      sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
      versionComment: 'v7.0.1',
    });
  });

  it('accepts a nested action path (org/repo/subpath@sha)', () => {
    const ref = parsePinnedActionRef(
      'github/codeql-action/init@f205ea1c3313d32999d8d6a48b4f6530d4437b38 # v4.37.4',
      'test'
    );
    expect(ref.repo).toBe('github/codeql-action/init');
  });

  // Regression: this exact floating major tag shipped in claude.yml (#600) and
  // let a moved tag execute with id-token: write + a secret, no PR involved.
  it('rejects a floating major-version tag', () => {
    expect(() => parsePinnedActionRef('anthropics/claude-code-action@v1', 'test')).toThrow(
      ActionPinError
    );
    expect(() => parsePinnedActionRef('anthropics/claude-code-action@v1', 'test')).toThrow(
      /floating tag/
    );
  });

  it('rejects a floating full-semver tag', () => {
    expect(() => parsePinnedActionRef('actions/checkout@v7.0.1', 'test')).toThrow(/floating tag/);
  });

  it('rejects a branch ref', () => {
    expect(() => parsePinnedActionRef('actions/checkout@main', 'test')).toThrow(/floating tag/);
  });

  it('rejects a ref with no @ at all', () => {
    expect(() => parsePinnedActionRef('actions/checkout', 'test')).toThrow(/no @ref/);
  });

  // A 40-char SHA with no trailing comment is unambiguous to the runner but
  // undiscoverable to a human auditing the file — the version comment is the
  // convention this repo already uses everywhere else (ci.yml, codeql.yml,
  // release.yml), so the gate enforces it too.
  it('rejects a SHA pin missing its version comment', () => {
    expect(() =>
      parsePinnedActionRef('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'test')
    ).toThrow(/missing a trailing/);
  });

  it('rejects a short hex string that is not a full 40-char SHA', () => {
    expect(() => parsePinnedActionRef('actions/checkout@abc123 # v7', 'test')).toThrow(
      /not a recognized/
    );
  });
});

describe('extractUsesValues', () => {
  it('pulls the ref out of each "uses:" line, ignoring indentation and list markers', () => {
    const yaml = [
      'steps:',
      '  - name: Checkout',
      '    uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      '  - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9',
    ].join('\n');
    expect(extractUsesValues(yaml)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      'pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9',
    ]);
  });

  it('returns an empty list for a file with no uses: lines', () => {
    expect(extractUsesValues('name: CI\non:\n  push:\n')).toEqual([]);
  });
});

describe('checkFile', () => {
  // Regression: unlike its sibling workflowFiles() (which wraps a readdirSync
  // failure in ActionPinError with a `cause`), checkFile's readFileSync used
  // to let the raw Node fs error escape unwrapped — inconsistent error
  // context within the same module.
  it('wraps a read failure in ActionPinError, chaining the fs error as cause', () => {
    let thrown: unknown;
    try {
      checkFile('does-not-exist.yml');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ActionPinError);
    expect((thrown as ActionPinError).message).toMatch(/could not read/);
    expect((thrown as ActionPinError).cause).toBeInstanceOf(Error);
  });
});

describe('checkAllWorkflowRefs against the real .github/workflows directory', () => {
  // Regression (#600): claude.yml referenced actions/checkout@v7 and
  // anthropics/claude-code-action@v1 — both floating tags — in a job also
  // granted id-token: write. This runs the same scan `pnpm check:action-pins`
  // runs in CI, but as a vitest boundary test against the real files on disk
  // (not hardcoded fixture strings), so a future PR that reintroduces a
  // floating ref anywhere under .github/workflows/ fails locally too.
  it('finds zero unpinned action refs across every workflow file', () => {
    expect(checkAllWorkflowRefs()).toEqual([]);
  });
});
