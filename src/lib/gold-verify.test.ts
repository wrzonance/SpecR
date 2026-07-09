// src/lib/gold-verify.test.ts
import { describe, expect, it } from 'vitest';
import { verifyCorpus, blessEntries, type CorpusResult } from './gold-verify.js';
import type { GoldFingerprint } from './gold-fingerprint.js';
import type { GoldStore } from './gold-store.js';

const fp = (parts: number): GoldFingerprint => ({
  section: '09 91 23',
  parts,
  noteLeaks: 0,
  maxDepth: 2,
  partShape: [[1], [2], []],
  confidenceBands: { high: 5, review: 1, low: 0 },
});
const blessed = (parts: number): GoldStore['x'] => ({
  fingerprint: fp(parts),
  source: 'ARCAT',
  blessedAt: '2026-07-08T00:00:00.000Z',
});
const ok = (path: string, parts: number): CorpusResult => ({
  path,
  ok: true,
  fingerprint: fp(parts),
});
const fail = (path: string, error: string): CorpusResult => ({ path, ok: false, error });

describe('verifyCorpus', () => {
  it('passes when a blessed file matches its fingerprint', () => {
    const store: GoldStore = { 'a.docx': blessed(3) };
    const r = verifyCorpus([ok('a.docx', 3)], store);
    expect(r.failures).toEqual([]);
    expect(r.gated).toBe(1);
    expect(r.ungated).toBe(0);
  });

  it('fails when a blessed file drifts', () => {
    const store: GoldStore = { 'a.docx': blessed(3) };
    const r = verifyCorpus([ok('a.docx', 4)], store);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.deltas[0]!.field).toBe('parts');
  });

  it('counts an un-blessed file as ungated, not a failure', () => {
    const r = verifyCorpus([ok('new.docx', 3)], {});
    expect(r.failures).toEqual([]);
    expect(r.ungated).toBe(1);
  });

  it('reports a blessed file that is absent locally', () => {
    const store: GoldStore = { 'gone.docx': blessed(3) };
    const r = verifyCorpus([], store);
    expect(r.missingLocally).toEqual(['gone.docx']);
    expect(r.failures).toEqual([]);
  });

  it('fails a blessed file that no longer parses', () => {
    const store: GoldStore = { 'a.docx': blessed(3) };
    const r = verifyCorpus([fail('a.docx', 'boom')], store);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.deltas[0]!.actual).toContain('boom');
  });
});

describe('blessEntries', () => {
  const meta = { blessedAt: '2026-07-08T12:00:00.000Z', sourceOf: () => 'CPI' as string | null };

  it('inserts a new entry with the current fingerprint and stamped metadata', () => {
    const { store, blessed: names } = blessEntries({}, [ok('a.docx', 3)], meta);
    expect(names).toEqual(['a.docx']);
    expect(store['a.docx']!.fingerprint.parts).toBe(3);
    expect(store['a.docx']!.source).toBe('CPI');
    expect(store['a.docx']!.blessedAt).toBe('2026-07-08T12:00:00.000Z');
  });

  it('does not mutate the input store (immutability)', () => {
    const input: GoldStore = {};
    blessEntries(input, [ok('a.docx', 3)], meta);
    expect(input).toEqual({});
  });

  it('preserves an existing note on re-bless', () => {
    const input: GoldStore = {
      'a.docx': { ...blessed(3), note: 'known CPI offset' },
    };
    const { store } = blessEntries(input, [ok('a.docx', 9)], meta);
    expect(store['a.docx']!.note).toBe('known CPI offset');
    expect(store['a.docx']!.fingerprint.parts).toBe(9);
  });

  it('skips (does not bless) a file that fails to parse', () => {
    const { store, blessed: names, skipped } = blessEntries({}, [fail('bad.docx', 'boom')], meta);
    expect(names).toEqual([]);
    expect(store).toEqual({});
    expect(skipped).toEqual([{ path: 'bad.docx', error: 'boom' }]);
  });
});
