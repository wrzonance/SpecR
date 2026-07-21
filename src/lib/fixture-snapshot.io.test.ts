// src/lib/fixture-snapshot.io.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSnapshot, readSnapshot, fixtureRecord } from './fixture-snapshot.js';
import type { Snapshot } from './fixture-snapshot.js';
import { parse } from '../parser/index.js';

describe('writeSnapshot / readSnapshot round-trip', () => {
  it('writes to the given output dir and reads back an identical snapshot', async () => {
    const snap: Snapshot = {
      'X.docx': { parts: 3, noteLeaks: 0, refs: ['sec:09 91 00'], render: 'a\nb' },
    };
    const out = mkdtempSync(join(tmpdir(), 'fx-'));
    const path = await writeSnapshot(snap, out, 'smoke');
    expect(path).toBe(join(out, 'smoke.json'));
    expect(await readSnapshot(path)).toEqual(snap);
  });

  it('rejects a malformed snapshot file at the boundary (not a silent cast)', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fx-'));
    const bad = join(out, 'bad.json');
    writeFileSync(bad, JSON.stringify({ 'X.docx': { parts: 'three', noteLeaks: 0 } }));
    await expect(readSnapshot(bad)).rejects.toThrow(/invalid snapshot file/);
  });
});

// One committed .sec fixture proves the parse → record path on real data without the
// full-corpus sweep. globSync so we don't hardcode a UFGS subpath.
const ONE_SEC = globSync('docs/references/**/*.{sec,SEC}').sort((a, b) => a.localeCompare(b))[0];

describe.skipIf(!ONE_SEC)('fixtureRecord on a real .sec fixture', () => {
  it('produces a well-formed record', async () => {
    const { tree, refs } = await parse(readFileSync(ONE_SEC!), ONE_SEC!);
    const rec = fixtureRecord(tree, refs);
    expect(typeof rec.parts).toBe('number');
    expect(typeof rec.render).toBe('string');
    expect(Array.isArray(rec.refs)).toBe(true);
  });
});

// docs/references (the corpus fixture:snapshot/diff sweeps) is entirely
// SpecsIntact .SEC/.sec — 665 .SEC + 1 .sec, zero .docx (verified via
// `find docs/references -type f`). .SEC has no w:pgSz/OOXML sectPr, so
// pageSize (#509) can never appear there: the corpus-wide diff reporting
// 0/666 changed after wiring pageSize through the parser only proves the
// .SEC path is untouched, not that pageSize is additive against a DOCX body.
// That claim is pinned here instead, against the one real, non-copyrighted
// DOCX fixture committed to the repo (tests/fixtures/libreoffice), mirroring
// the ONE_SEC pattern above: present at tree root, but invisible to the
// render-derived fixture record (parts/noteLeaks/refs/render) — the same
// property the corpus diff tool would flag as a "body/AST-structure delta"
// if pageSize ever leaked into it.
const ONE_DOCX = 'tests/fixtures/libreoffice/csi-spec-sample.docx';

describe('pageSize is additive-only at the fixture-record boundary', () => {
  it('populates tree.pageSize without perturbing the render-derived record', async () => {
    const { tree, refs } = await parse(readFileSync(ONE_DOCX), ONE_DOCX);

    expect(tree.pageSize).toBeDefined();
    expect(tree.pageSize?.width).toBeGreaterThan(0);
    expect(tree.pageSize?.height).toBeGreaterThan(0);

    const rec = fixtureRecord(tree, refs);
    expect(typeof rec.parts).toBe('number');
    expect(typeof rec.render).toBe('string');
    // pageSize is page-setup metadata, not document body content — it must
    // never leak into the rendered markdown.
    expect(rec.render).not.toMatch(/pgSz|pageSize|orientation/i);
  });
});
