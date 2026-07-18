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

/** A single-row, single-column table whose one cell's content is fully
 *  caller-supplied — for pinning shape-only divergence (formatting/attribute
 *  structure) at a FIXED row/column count, where `tableBlob`'s fixed cell
 *  shape (`w:p > w:r > w:t`) can't vary. */
function tableBlobWithCellContent(cellContent: readonly FingerprintNode[]): FingerprintNode[] {
  return [
    {
      'w:tbl': [{ 'w:tblGrid': [{ 'w:gridCol': [] }] }, { 'w:tr': [{ 'w:tc': cellContent }] }],
    },
  ];
}

/** Hand-built preserveOrder-shaped text box blob (`w:drawing > w:txbxContent`) —
 *  the non-table `kind` fingerprintBlob/inferKind must distinguish from a table. */
function textBoxBlob(text: string): FingerprintNode[] {
  return [
    {
      'w:drawing': [
        { 'w:txbxContent': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] }] },
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

  it('is kind-sensitive: a table and a text box diverge on both kind and hash', () => {
    const table = tableBlob([['A1']]);
    const textBox = textBoxBlob('A1');

    const tableFp = fingerprintBlob(table);
    const textBoxFp = fingerprintBlob(textBox);

    expect(tableFp.kind).toBe('table');
    expect(textBoxFp.kind).toBe('textBox');
    expect(tableFp.hash).not.toBe(textBoxFp.hash);
  });

  it('counts only the outer table dimensions — a nested table in a cell does not inflate rows/columns (#520 review)', () => {
    // Outer table is 1 row x 1 column; its single cell holds a nested 2-row x
    // 3-column table. findAllByTag-style descent would report rows=3/columns=4;
    // the fingerprint must report the host table's own 1x1 dimensions.
    const nestedTable: FingerprintNode = {
      'w:tbl': [
        { 'w:tblGrid': [{ 'w:gridCol': [] }, { 'w:gridCol': [] }, { 'w:gridCol': [] }] },
        { 'w:tr': [{ 'w:tc': [] }, { 'w:tc': [] }, { 'w:tc': [] }] },
        { 'w:tr': [{ 'w:tc': [] }, { 'w:tc': [] }, { 'w:tc': [] }] },
      ],
    };
    const outer = tableBlobWithCellContent([nestedTable]);

    const fp = fingerprintBlob(outer);

    expect(fp.rows).toBe(1);
    expect(fp.columns).toBe(1);
  });

  it('is structure-sensitive to non-text tag/attribute shape at a FIXED row/column count (geometry unchanged, formatting shape changed)', () => {
    // Both blobs are 1 row x 1 column — only the cell's INTERNAL tag shape
    // differs (an added w:rPr/w:b formatting wrapper around the run), never
    // its text — pinning that formatting divergence is detectable, not just
    // row/column counts (the module's own doc comment claims both).
    const plainRun = tableBlobWithCellContent([
      { 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': 'A1' }] }] }] },
    ]);
    const boldRun = tableBlobWithCellContent([
      { 'w:p': [{ 'w:r': [{ 'w:rPr': [{ 'w:b': [] }] }, { 'w:t': [{ '#text': 'A1' }] }] }] },
    ]);

    const plainFp = fingerprintBlob(plainRun);
    const boldFp = fingerprintBlob(boldRun);

    expect(plainFp.rows).toBe(boldFp.rows);
    expect(plainFp.columns).toBe(boldFp.columns);
    expect(plainFp.hash).not.toBe(boldFp.hash);
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
