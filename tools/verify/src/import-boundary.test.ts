// Pins the WT-150 design's import-boundary invariant: tools/verify never
// imports from the repo root's src/** at compile time or runtime — every
// shared response shape this package needs (ParseJob, TemplateImportData,
// PropertyDecision, ...) is an independently hand-mirrored Zod schema in
// api-client/schemas.ts, never a type or value pulled in from ../../../src.
//
// Enforced two ways below:
//   1. `findOutOfBoundsSpecifiers` is unit-tested directly against both a
//      synthetic violation and a synthetic in-package import first, so this
//      file proves its own check actually discriminates before trusting it.
//   2. That same detector then walks tools/verify's real .ts/.js source tree
//      (src/ and public/) and must find zero violations — a future import
//      that escapes the package fails this test by name and specifier.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findOutOfBoundsSpecifiers, listPackageSourceFiles } from './import-boundary.js';

// Synthetic specifiers are assembled from parts (never written as a literal
// `from '.../src/...'` in this file's own source text) so that the
// whole-tree scan below — which reads this very file's raw bytes — never
// mistakes these fixtures for a real out-of-bounds import.
const escapingSpecifier = ['..', '..', '..', '..', 'src', 'parser', 'index.js'].join('/');
const inPackageSpecifier = ['..', 'errors.js'].join('/');

describe('import boundary (tools/verify vs repo root src/**)', () => {
  const packageRoot = resolve(import.meta.dirname, '..');

  it('detector flags a synthetic import that escapes the package root', () => {
    const fakeFile = resolve(packageRoot, 'src', 'some-module.ts');
    const badSource = `import { parse } from '${escapingSpecifier}';\n`;

    const violations = findOutOfBoundsSpecifiers(packageRoot, fakeFile, badSource);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe(escapingSpecifier);
    expect(violations[0]?.resolvedPath.startsWith(packageRoot)).toBe(false);
  });

  it('detector flags a synthetic dynamic import() and require() the same way', () => {
    const fakeFile = resolve(packageRoot, 'src', 'some-module.ts');
    const dynamicSource = `const mod = await import('${escapingSpecifier}');\n`;
    const requireSource = `const mod = require('${escapingSpecifier}');\n`;

    expect(findOutOfBoundsSpecifiers(packageRoot, fakeFile, dynamicSource)).toHaveLength(1);
    expect(findOutOfBoundsSpecifiers(packageRoot, fakeFile, requireSource)).toHaveLength(1);
  });

  it('detector allows an in-package relative import', () => {
    const fakeFile = resolve(packageRoot, 'src', 'api-client', 'client.ts');
    const goodSource = `import { VerifyApiError } from '${inPackageSpecifier}';\n`;

    expect(findOutOfBoundsSpecifiers(packageRoot, fakeFile, goodSource)).toEqual([]);
  });

  it("tools/verify's real source tree has zero imports reaching outside the package", () => {
    const files = [
      ...listPackageSourceFiles(resolve(packageRoot, 'src')),
      ...listPackageSourceFiles(resolve(packageRoot, 'public')),
    ];
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) =>
      findOutOfBoundsSpecifiers(packageRoot, file, readFileSync(file, 'utf-8'))
    );

    expect(violations).toEqual([]);
  });
});
