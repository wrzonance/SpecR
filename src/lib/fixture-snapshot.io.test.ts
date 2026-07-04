// src/lib/fixture-snapshot.io.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, globSync, readFileSync } from 'node:fs';
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
