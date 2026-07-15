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
});
