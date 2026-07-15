// Pins the README's "openapi.yaml no-op" claim (#305 task 7/7): this whole
// tools/verify build adds zero endpoints to the main SpecR REST API, so
// `git diff origin/main -- src/ openapi.yaml` must stay empty for the
// entire branch — no commit under this feature ever touches the repo
// root's own src/ tree or its hand-authored API contract.
//
// This is a git-state check, not a static one (import-boundary.test.ts
// already covers "never imports from repo-root src/**" at compile time;
// this covers "never edits it" at the git-history level), so it only runs
// when `origin/main` is actually resolvable locally — a shallow clone that
// never fetched `main` (e.g. `actions/checkout`'s default fetch-depth: 1)
// skips rather than failing for an environment reason unrelated to the
// invariant itself. Every normal dev worktree and any checkout that has run
// `git fetch origin main` (this repo's own loc-check CI job does, via
// fetch-depth: 0) resolves it and the assertion runs for real.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function resolveGitRef(repoRoot: string, ref: string): boolean {
  try {
    // Same trusted, environment-provided build tool workspace-isolation.test.ts
    // already shells out to — not reachable from user/request input.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync('git', ['rev-parse', '--verify', ref], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('openapi.yaml no-op: this branch never touches repo-root src/ or openapi.yaml', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const baseRefAvailable = resolveGitRef(repoRoot, 'origin/main');

  it.skipIf(!baseRefAvailable)('git diff origin/main -- src/ openapi.yaml is empty', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const diff = execFileSync('git', ['diff', 'origin/main', '--', 'src/', 'openapi.yaml'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf-8');
    expect(diff).toBe('');
  });
});
