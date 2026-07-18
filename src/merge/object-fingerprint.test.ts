import { describe, it, expect } from 'vitest';
import { fingerprintBlob, fingerprintsDiverge } from './object-fingerprint.js';
import type { FingerprintNode } from './object-fingerprint.js';

/** Hand-built fast-xml-parser preserveOrder-shaped table blob, N rows x cells[i].length. */
function tableBlob(rowTexts: readonly (readonly string[])[]): FingerprintNode[] {
  const columnCount = rowTexts[0]?.length ?? 0;
  return [
    {
      'w:tbl': [
        { 'w:tblGrid': Array.from({ length: columnCount }, () => ({ 'w:gridCol': [] })) },
        ...rowTexts.map((cells) => ({
          'w:tr': cells.map((text) => ({
            'w:tc': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] }],
          })),
        })),
      ],
    },
  ];
}

describe('fingerprintBlob', () => {
  it('is text-blind: same row/column structure, different cell text, hashes equal', () => {
    const a = tableBlob([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ]);
    const b = tableBlob([
      ['zzz', 'yyy'],
      ['xxx', 'www'],
    ]);

    expect(fingerprintBlob(a).hash).toBe(fingerprintBlob(b).hash);
  });

  it('is structure-sensitive: adding a row changes the hash', () => {
    const twoRows = tableBlob([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ]);
    const threeRows = tableBlob([
      ['A1', 'B1'],
      ['A2', 'B2'],
      ['A3', 'B3'],
    ]);

    expect(fingerprintBlob(twoRows).hash).not.toBe(fingerprintBlob(threeRows).hash);
  });

  it('is structure-sensitive: adding a column changes the hash', () => {
    const twoColumns = tableBlob([['A1', 'B1']]);
    const threeColumns = tableBlob([['A1', 'B1', 'C1']]);

    expect(fingerprintBlob(twoColumns).hash).not.toBe(fingerprintBlob(threeColumns).hash);
  });
});

describe('fingerprintsDiverge', () => {
  it('is false for two fingerprints computed from the same structure', () => {
    const blob = tableBlob([['A1', 'B1']]);

    expect(fingerprintsDiverge(fingerprintBlob(blob), fingerprintBlob(blob))).toBe(false);
  });

  it('is true when the underlying structure differs', () => {
    const base = tableBlob([['A1', 'B1']]);
    const theirs = tableBlob([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ]);

    expect(fingerprintsDiverge(fingerprintBlob(base), fingerprintBlob(theirs))).toBe(true);
  });
});
