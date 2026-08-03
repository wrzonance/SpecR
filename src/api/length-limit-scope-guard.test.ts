// src/api/length-limit-scope-guard.test.ts
//
// #626 (ADR-086) is a docs-only "accept and document" change: it must never
// touch the MCP contract machinery (contract-map.ts,
// contract-schema-sharing-map.ts, contract-write-response-map.ts) that a
// sibling workstream is concurrently mid-edit on — see ADR-086's rejected
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

describe('scope guard: #626 (ADR-086) never touches MCP contract machinery', () => {
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
