import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins the WT-150 spike's finding 0 (most impactful): tools/verify MUST be an
// isolated pnpm workspace root, or `pnpm --dir tools/verify install` silently
// resolves against the REPO ROOT importer instead — confirmed empirically
// pre-fix: "Already up to date", zero node_modules created under
// tools/verify, root untouched. Adding tools/verify/pnpm-workspace.yaml
// (packages: []) fixes it, because pnpm resolves the NEAREST
// pnpm-workspace.yaml walking up from cwd and stops there.
//
// `build`/`lint` are not separately exercised here: neither invokes a package
// manager, so neither can mutate a lockfile or node_modules by construction —
// the install boundary above is the only operation with that risk.
describe('workspace isolation (tools/verify vs repo root)', () => {
  const toolsVerifyRoot = resolve(import.meta.dirname, '..');
  const repoRoot = resolve(toolsVerifyRoot, '..', '..');

  it('declares an isolated workspace root via packages: []', () => {
    const workspaceYamlPath = resolve(toolsVerifyRoot, 'pnpm-workspace.yaml');
    expect(existsSync(workspaceYamlPath)).toBe(true);

    const contents = readFileSync(workspaceYamlPath, 'utf-8');
    expect(contents).toMatch(/packages:\s*\[\s*\]/);
  });

  it('resolves its own node_modules and lockfile, independent of root', () => {
    expect(existsSync(resolve(toolsVerifyRoot, 'node_modules'))).toBe(true);
    expect(existsSync(resolve(toolsVerifyRoot, 'pnpm-lock.yaml'))).toBe(true);
  });

  it('re-running install against tools/verify never mutates the root lockfile or node_modules', () => {
    const rootLockfilePath = resolve(repoRoot, 'pnpm-lock.yaml');
    const beforeLockfile = readFileSync(rootLockfilePath, 'utf-8');
    const beforeTopLevel = readdirSync(resolve(repoRoot, 'node_modules')).sort((a, b) =>
      a.localeCompare(b)
    );

    // 'pnpm' here is the trusted, environment-provided build tool this
    // whole dev/CI pipeline already runs under (same as `pnpm test`
    // invoking this very file); not reachable from user/request input.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync('pnpm', ['--dir', toolsVerifyRoot, 'install', '--frozen-lockfile'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });

    const afterLockfile = readFileSync(rootLockfilePath, 'utf-8');
    const afterTopLevel = readdirSync(resolve(repoRoot, 'node_modules')).sort((a, b) =>
      a.localeCompare(b)
    );

    expect(afterLockfile).toBe(beforeLockfile);
    expect(afterTopLevel).toEqual(beforeTopLevel);
  }, 30_000);

  // The reverse direction: the root workspace's own package manager must
  // never even discover tools/verify as a member, let alone install/build
  // against it. `pnpm list -r` is read-only (no install/mutation) and
  // reports pnpm's actual resolved workspace membership — the same
  // resolution `pnpm install`/`build`/`lint`/`test` use at each root.
  it('root workspace membership excludes tools/verify, and vice versa', () => {
    // Same trusted, environment-provided build tool as the install call
    // above — read-only here (`list`, not `install`), still not reachable
    // from user/request input.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const rootMembersRaw = execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf-8');
    const rootMembers = JSON.parse(rootMembersRaw) as { path: string }[];
    expect(rootMembers.some((member) => member.path === toolsVerifyRoot)).toBe(false);

    const verifyListArgs = ['--dir', toolsVerifyRoot, 'list', '-r', '--depth', '-1', '--json'];
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const verifyMembersRaw = execFileSync('pnpm', verifyListArgs, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf-8');
    const verifyMembers = JSON.parse(verifyMembersRaw) as { path: string }[];
    expect(verifyMembers.some((member) => member.path === repoRoot)).toBe(false);
  });
});
