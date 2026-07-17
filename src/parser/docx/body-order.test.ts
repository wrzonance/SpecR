import { describe, it, expect } from 'vitest';
import { computeBodyOrder } from './body-order.js';
import { createOrderedDocumentXmlBuilder } from './xml-utils.js';
import { parseDocument } from './document.js';
import { emptyNumberingMap } from './numbering.js';
import { buildStyleMap } from './styles.js';
import { ParserError } from '../error.js';

const EMPTY_STYLES = buildStyleMap(
  `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
);

function makeDocXml(bodyXml: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyXml}</w:body></w:document>`
  );
}

function para(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function cell(paragraphsXml: string): string {
  return `<w:tc>${paragraphsXml}</w:tc>`;
}

function row(cellsXml: string): string {
  return `<w:tr>${cellsXml}</w:tr>`;
}

function table(rowsXml: string): string {
  return `<w:tbl>${rowsXml}</w:tbl>`;
}

// Reads the text out of a captured paragraph blob's [0]'th (only) node, to
// assert WHICH paragraph a blob entry actually wraps without depending on
// internal ObjectBlobNode shape beyond what the schema already guarantees.
function blobText(blob: readonly unknown[]): string {
  const xml = createOrderedDocumentXmlBuilder().build(blob);
  const match = /<w:t>([^<]*)<\/w:t>/.exec(xml);
  return match?.[1] ?? '';
}

describe('computeBodyOrder — paragraph-only body (no tables)', () => {
  it('returns an empty tables list and one blob per paragraph, document-order-aligned', () => {
    const xml = makeDocXml(para('first') + para('second') + para('third'));
    const order = computeBodyOrder(xml);
    expect(order.tables).toEqual([]);
    expect(order.paragraphBlobs).toHaveLength(3);
    expect(order.paragraphBlobs.map(blobText)).toEqual(['first', 'second', 'third']);
  });

  it('returns empty tables/paragraphBlobs for a body with no w:p or w:tbl children', () => {
    const xml = makeDocXml('<w:sectPr/>');
    expect(computeBodyOrder(xml)).toEqual({ tables: [], paragraphBlobs: [] });
  });
});

describe('computeBodyOrder — cross-tag interleaving', () => {
  it('assigns a table the array index of the paragraph immediately preceding it', () => {
    const xml = makeDocXml(para('p0') + para('p1') + table(row(cell(para('cell')))) + para('p2'));
    const order = computeBodyOrder(xml);
    expect(order.paragraphBlobs).toHaveLength(3);
    expect(order.paragraphBlobs.map(blobText)).toEqual(['p0', 'p1', 'p2']);
    expect(order.tables).toHaveLength(1);
    expect(order.tables[0]?.precedingParagraphIndex).toBe(1); // index of p1
  });

  it('assigns undefined precedingParagraphIndex when the table precedes any paragraph', () => {
    const xml = makeDocXml(table(row(cell(para('cell')))) + para('p0'));
    const order = computeBodyOrder(xml);
    expect(order.tables).toHaveLength(1);
    expect(order.tables[0]?.precedingParagraphIndex).toBeUndefined();
    expect(order.paragraphBlobs.map(blobText)).toEqual(['p0']);
  });

  it('assigns undefined for a body containing only a table and no paragraphs at all', () => {
    const xml = makeDocXml(table(row(cell(para('only cell')))));
    const order = computeBodyOrder(xml);
    expect(order.tables).toHaveLength(1);
    expect(order.tables[0]?.precedingParagraphIndex).toBeUndefined();
    expect(order.paragraphBlobs).toEqual([]);
  });

  it('gives two consecutive tables (no intervening paragraph) the SAME precedingParagraphIndex, in document order', () => {
    const tableA = table(row(cell(para('a cell'))));
    const tableB = table(row(cell(para('b cell'))));
    const xml = makeDocXml(para('p0') + tableA + tableB + para('p1'));
    const order = computeBodyOrder(xml);
    expect(order.tables).toHaveLength(2);
    expect(order.tables[0]?.precedingParagraphIndex).toBe(0);
    expect(order.tables[1]?.precedingParagraphIndex).toBe(0);
    // Document order preserved: tableA is captured before tableB.
    expect(order.tables.map((t) => blobText(t.blob))).toEqual(['a cell', 'b cell']);
  });

  it('handles multiple tables interleaved with multiple paragraphs, each keyed to its true preceding paragraph', () => {
    const xml = makeDocXml(
      para('p0') +
        table(row(cell(para('t1')))) +
        para('p1') +
        para('p2') +
        table(row(cell(para('t2')))) +
        para('p3')
    );
    const order = computeBodyOrder(xml);
    expect(order.paragraphBlobs.map(blobText)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(order.tables).toHaveLength(2);
    expect(order.tables[0]?.precedingParagraphIndex).toBe(0); // after p0
    expect(order.tables[1]?.precedingParagraphIndex).toBe(2); // after p2
  });
});

// KNOWN AMBIGUITY (mirrors tables.ts's own #293 decision): a w:tbl or w:p
// nested inside a table cell is never walked — only w:body's own DIRECT
// children are visited. computeBodyOrder must not surface the nested table
// as a second `tables` entry, nor the nested cell paragraph as a
// `paragraphBlobs` entry.
describe('computeBodyOrder — nested-in-cell exclusion', () => {
  it('does not discover a table nested inside a cell of a top-level table', () => {
    const nestedTable = table(row(cell(para('nested secret'))));
    const outerCell = cell(para('outer visible') + nestedTable);
    const xml = makeDocXml(para('p0') + table(row(outerCell)) + para('p1'));
    const order = computeBodyOrder(xml);
    expect(order.tables).toHaveLength(1); // only the outer table
    expect(order.paragraphBlobs.map(blobText)).toEqual(['p0', 'p1']); // no cell paragraphs
  });
});

describe('computeBodyOrder — paragraphBlobs index alignment with document.ts', () => {
  it('produces exactly one blob per paragraph document.ts parses, in the same order', () => {
    const xml = makeDocXml(
      para('alpha') + table(row(cell(para('cell')))) + para('beta') + para('gamma')
    );
    const order = computeBodyOrder(xml);
    const paragraphs = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);

    expect(order.paragraphBlobs).toHaveLength(paragraphs.length);
    expect(order.paragraphBlobs.map(blobText)).toEqual(paragraphs.map((p) => p.text));
  });
});

describe('computeBodyOrder — blob fidelity', () => {
  it('captures a table blob that reserializes byte-identical to its source XML', () => {
    const tableXml = table(row(cell(para('exact'))));
    const xml = makeDocXml(para('p0') + tableXml);
    const order = computeBodyOrder(xml);
    const rebuilt = createOrderedDocumentXmlBuilder().build(order.tables[0]?.blob ?? []);
    expect(rebuilt).toBe(tableXml);
  });

  it('captures a paragraph blob that reserializes byte-identical to its source XML', () => {
    const paragraphXml = para('exact para');
    const xml = makeDocXml(paragraphXml);
    const order = computeBodyOrder(xml);
    const rebuilt = createOrderedDocumentXmlBuilder().build(order.paragraphBlobs[0] ?? []);
    expect(rebuilt).toBe(paragraphXml);
  });
});

describe('computeBodyOrder — errors', () => {
  it('throws ParserError DOCX_BODY_ORDER_XML_INVALID with cause for malformed XML', () => {
    let caught: unknown;
    try {
      computeBodyOrder('<not valid xml');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_BODY_ORDER_XML_INVALID');
    expect((caught as ParserError).cause).toBeDefined();
  });
});
