// Import-boundary detector for the visual round-trip verification harness
// (#150). tools/verify is an isolated pnpm package (see pnpm-workspace.yaml)
// with zero compile-time or runtime dependency on the repo root's src/** —
// every shared response shape it needs is an independently hand-mirrored
// Zod schema in api-client/schemas.ts, never an import of src/ast's own
// types. This module is what import-boundary.test.ts pins that invariant
// with; it is not itself part of the harness's runtime request path.
import { readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

export interface ImportViolation {
  readonly file: string;
  readonly specifier: string;
  readonly resolvedPath: string;
}

// Matches this package's own style exactly (single-quoted, ESM, prettier-
// formatted) — a scoped detector for this invariant, not a general JS/TS
// parser. Covers static imports/re-exports, dynamic import(), and require().
const RELATIVE_IMPORT_PATTERNS = [
  /\bfrom\s+'(\.[^']+)'/g,
  /\bimport\(\s*'(\.[^']+)'\s*\)/g,
  /\brequire\(\s*'(\.[^']+)'\s*\)/g,
];

function extractRelativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Flag every relative import/require/dynamic-import specifier in `source`
 * (a file at `filePath`) whose resolved target falls outside `packageRoot`.
 * Bare (non-relative) specifiers are npm packages resolved via node_modules,
 * not filesystem paths, so they are out of scope for this check by design.
 */
export function findOutOfBoundsSpecifiers(
  packageRoot: string,
  filePath: string,
  source: string
): ImportViolation[] {
  const fileDir = dirname(filePath);
  return extractRelativeSpecifiers(source).flatMap((specifier) => {
    const resolvedPath = resolve(fileDir, specifier);
    const isInBounds = resolvedPath === packageRoot || resolvedPath.startsWith(packageRoot + '/');
    return isInBounds ? [] : [{ file: filePath, specifier, resolvedPath }];
  });
}

const SCAN_EXTENSIONS = new Set(['.ts', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist']);

/** Recursively list every .ts/.js file under `dir`, skipping node_modules/dist. */
export function listPackageSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const entryPath = join(dir, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      return SKIP_DIRS.has(entry) ? [] : listPackageSourceFiles(entryPath);
    }
    return SCAN_EXTENSIONS.has(extname(entry)) ? [entryPath] : [];
  });
}
