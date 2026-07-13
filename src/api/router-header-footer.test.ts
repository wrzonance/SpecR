import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Router as RouterType } from 'express';
import { router } from './router.js';

// ─── Invariant: router.ts and its header/footer collaborators stay under
// the repo's 400-line hard cap (eslint.config.js max-lines) ────────────────
//
// A dedicated test (rather than relying on `pnpm lint` alone) pins the
// "split into a sub-router if exhausted" contract from the design doc: if
// this ever regresses, the failure names the exact file and count instead
// of a generic eslint diagnostic.

const MAX_LINES = 400;

function lineCount(relativePath: string): number {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return readFileSync(path, 'utf8').split('\n').length;
}

describe('router.ts line budget (#476)', () => {
  it.each([
    ['./router.ts', lineCount('./router.ts')],
    ['./header-footer.ts', lineCount('./header-footer.ts')],
    ['./header-footer-resolve.ts', lineCount('./header-footer-resolve.ts')],
  ])('%s stays at or under the %d-line hard cap', (_name, count) => {
    expect(count).toBeLessThanOrEqual(MAX_LINES);
  });
});

// ─── Invariant: all 15 header/footer operations are actually mounted on the
// real router, not only on the isolated test apps the handler-level
// integration tests build ──────────────────────────────────────────────────

interface RouteLayer {
  readonly route?: {
    readonly path: string;
    readonly methods: Readonly<Record<string, boolean>>;
  };
}

function isRouted(target: RouterType, method: string, path: string): boolean {
  const stack = (target as unknown as { stack: readonly RouteLayer[] }).stack;
  return stack.some((layer) => layer.route?.path === path && layer.route.methods[method] === true);
}

const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['get', '/libraries/:id/header-footer'],
  ['put', '/libraries/:id/header-footer'],
  ['delete', '/libraries/:id/header-footer'],
  ['get', '/projects/:id/header-footer'],
  ['put', '/projects/:id/header-footer'],
  ['delete', '/projects/:id/header-footer'],
  ['get', '/packages/:id/header-footer'],
  ['put', '/packages/:id/header-footer'],
  ['delete', '/packages/:id/header-footer'],
  ['get', '/revisions/:id/header-footer'],
  ['put', '/revisions/:id/header-footer'],
  ['delete', '/revisions/:id/header-footer'],
  ['get', '/projects/:id/header-footer/resolved'],
  ['get', '/packages/:id/header-footer/resolved'],
  ['get', '/revisions/:id/header-footer/resolved'],
];

describe('router.ts wires all 15 header/footer operations (#476)', () => {
  it.each(EXPECTED_ROUTES)('%s %s is registered on the real router', (method, path) => {
    expect(isRouted(router, method, path)).toBe(true);
  });
});
