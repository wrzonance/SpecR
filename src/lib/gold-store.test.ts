import { describe, expect, it, afterEach } from 'vitest';
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoldStore, writeGoldStore, GoldStoreError, type GoldStore } from './gold-store.js';

const TMP = join(tmpdir(), 'specr-gold-store-test');

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const entry = (section: string) => ({
  fingerprint: {
    section,
    parts: 3,
    noteLeaks: 0,
    maxDepth: 2,
    partShape: [[1], [2], []],
    confidenceBands: { high: 5, review: 1, low: 0 },
    contentChars: [42, 88, 0],
  },
  source: 'ARCAT',
  blessedAt: '2026-07-08T00:00:00.000Z',
});

describe('gold-store', () => {
  it('missing file reads back as an empty store (first-run safe)', async () => {
    expect(await readGoldStore(join(TMP, 'nope.json'))).toEqual({});
  });

  it('round-trips a store through write then read', async () => {
    const store: GoldStore = { 'ARCAT/a.docx': entry('09 91 23') };
    const path = join(TMP, 'expectations.json');
    await writeGoldStore(store, path);
    expect(await readGoldStore(path)).toEqual(store);
  });

  it('writes sorted keys with a trailing newline (stable git diffs)', async () => {
    const store: GoldStore = { 'B/b.docx': entry('2'), 'A/a.docx': entry('1') };
    const path = join(TMP, 'expectations.json');
    await writeGoldStore(store, path);
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.indexOf('A/a.docx')).toBeLessThan(raw.indexOf('B/b.docx'));
  });

  it('fails loud (GoldStoreError) on a structurally invalid store', async () => {
    const path = join(TMP, 'bad.json');
    await mkdir(TMP, { recursive: true });
    await writeFile(path, JSON.stringify({ 'x.docx': { fingerprint: { parts: 'three' } } }));
    await expect(readGoldStore(path)).rejects.toBeInstanceOf(GoldStoreError);
  });

  it('fails loud (GoldStoreError) on malformed (non-JSON) input', async () => {
    const path = join(TMP, 'malformed.json');
    await mkdir(TMP, { recursive: true });
    // A truncated / merge-conflicted store: valid file, invalid JSON.
    await writeFile(path, '{ "a.docx": { "fingerprint": ');
    await expect(readGoldStore(path)).rejects.toBeInstanceOf(GoldStoreError);
  });
});
