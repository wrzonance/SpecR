// src/api/length-limit-scope-guard.test.ts
//
// #626 (ADR-088) is a docs-only "accept and document" change: it must never
// touch the MCP contract machinery (contract-map.ts,
// contract-schema-sharing-map.ts, contract-write-response-map.ts) that a
// sibling workstream is concurrently mid-edit on — see ADR-088's rejected
// option for why. A collision there wouldn't just conflict on merge, it
// would corrupt the ADR-044 REST<->MCP parity gates the sibling PR is
// actively changing.
//
// This pins that scope boundary at the git-diff level: it diffs this
// branch's commits (merge-base with origin/main, through HEAD) against the
// three guarded files and fails if any of them appear. Follows the same
// graceful self-skip pattern documented for `tools/verify`'s git-diff
// invariants in .github/workflows/ci.yml's "Verify Harness" job comment —
// when `origin/main` isn't resolvable (e.g. a shallow clone with
// `fetch-depth: 1`) the test skips rather than false-failing, so it asserts
// for real only where CI already fetches full history (`fetch-depth: 0`).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GUARDED_MCP_CONTRACT_FILES = [
  'src/mcp/contract-map.ts',
  'src/mcp/contract-schema-sharing-map.ts',
  'src/mcp/contract-write-response-map.ts',
] as const;

function resolveMergeBaseWithOriginMain(): string | undefined {
  try {
    // git is trusted dev tooling resolved from PATH in a CI/local dev shell,
    // not untrusted input — same pattern as
    // tools/verify/src/workspace-isolation.test.ts.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    return execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    // origin/main isn't resolvable (e.g. shallow clone, detached fixture
    // checkout) — the caller treats this as "can't assert, skip".
    return undefined;
  }
}

function changedGuardedFiles(mergeBase: string): string[] {
  const diffArgs = ['diff', '--name-only', mergeBase, 'HEAD', '--', ...GUARDED_MCP_CONTRACT_FILES];
  // git is trusted dev tooling resolved from PATH — see rationale above.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const output = execFileSync('git', diffArgs, { encoding: 'utf8' });
  return output.split('\n').filter((line) => line.length > 0);
}

describe('scope guard: #626 (ADR-088) never touches MCP contract machinery', () => {
  it('leaves contract-map.ts, contract-schema-sharing-map.ts, and contract-write-response-map.ts untouched', (ctx) => {
    const mergeBase = resolveMergeBaseWithOriginMain();
    if (mergeBase === undefined) {
      ctx.skip();
      return;
    }

    const changed = changedGuardedFiles(mergeBase);
    expect(
      changed,
      `#626 must stay docs-only; these MCP contract files must not appear in the branch diff: ${changed.join(', ')}`
    ).toEqual([]);
  });
});

// The guard above is only real enforcement in a job whose checkout resolves
// `origin/main` — otherwise resolveMergeBaseWithOriginMain() always throws
// and every run silently ctx.skip()s. `.github/workflows/ci.yml`'s `test`
// job (the one that actually runs this file via `pnpm test`) used a default
// `actions/checkout` with no `fetch-depth` override, which is shallow
// (depth 1) and never creates a local `origin/main` ref — unlike the
// `verify-harness` and `loc-check` jobs, which this file's own header comment
// cites as the pattern it follows. This pins the fix at the config level so a
// future edit to ci.yml can't silently reintroduce the self-skip.
const CI_WORKFLOW_PATH = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml');

/** Slice out one top-level job's body (2-space-indented `<jobName>:` through the next). */
function extractJobBlock(yaml: string, jobName: string): string {
  const lines = yaml.split('\n');
  const startIndex = lines.findIndex((line) => line === `  ${jobName}:`);
  if (startIndex === -1) {
    throw new Error(`job "${jobName}" not found in ${CI_WORKFLOW_PATH}`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (endOffset === -1 ? rest : rest.slice(0, endOffset)).join('\n');
}

/** Whether a line starts a new `steps:` list entry (`- uses:` / `- name:`). */
const isStepStartLine = (line: string): boolean => /^\s*- (uses|name):/.test(line);

/** Whether the job block's first `actions/checkout` step sets `fetch-depth: 0`. */
function checkoutStepHasFetchDepthZero(jobBlock: string): boolean {
  const lines = jobBlock.split('\n');
  const checkoutIndex = lines.findIndex((line) => line.includes('uses: actions/checkout@'));
  if (checkoutIndex === -1) return false;
  const linesFromCheckout = lines.slice(checkoutIndex);
  const nextStepOffset = linesFromCheckout.slice(1).findIndex(isStepStartLine);
  const checkoutStepLines =
    nextStepOffset === -1 ? linesFromCheckout : linesFromCheckout.slice(0, nextStepOffset + 1);
  return checkoutStepLines.some((line) => /fetch-depth:\s*0\b/.test(line));
}

describe('ci.yml: the job that runs this file checks out full history', () => {
  it('the "test" job checkout sets fetch-depth: 0, so the scope guard above asserts for real instead of self-skipping', () => {
    const yaml = readFileSync(CI_WORKFLOW_PATH, 'utf8');
    const jobBlock = extractJobBlock(yaml, 'test');
    expect(
      checkoutStepHasFetchDepthZero(jobBlock),
      '.github/workflows/ci.yml "test" job checkout must set fetch-depth: 0 (matching verify-harness/loc-check) — ' +
        'without it, git merge-base origin/main HEAD always throws in the job that runs `pnpm test`, so the scope ' +
        'guard test above always ctx.skip()s instead of asserting'
    ).toBe(true);
  });
});
