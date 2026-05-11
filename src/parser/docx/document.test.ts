import { describe, it, expect } from 'vitest';
import { parseDocument } from './document.js';
import { emptyNumberingMap } from './numbering.js';

function makeDocXml(paragraphs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
}

function makePara(opts: {
  text?: string;
  styleId?: string;
  numId?: number;
  ilvl?: number;
  leftIndent?: number;
  outlineLvl?: number;
  vanish?: boolean;
}): string {
  const numPr =
    opts.numId !== undefined
      ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`
      : '';
  const pStyle = opts.styleId ? `<w:pStyle w:val="${opts.styleId}"/>` : '';
  const ind = opts.leftIndent !== undefined ? `<w:ind w:left="${opts.leftIndent}"/>` : '';
  const outlineLvl =
    opts.outlineLvl !== undefined ? `<w:outlineLvl w:val="${opts.outlineLvl}"/>` : '';
  const vanishRpr = opts.vanish ? '<w:rPr><w:vanish/></w:rPr>' : '';
  const pPr = `<w:pPr>${pStyle}${numPr}${ind}${outlineLvl}${vanishRpr}</w:pPr>`;
  const run = opts.text !== undefined ? `<w:r><w:t>${opts.text}</w:t></w:r>` : '';
  return `<w:p>${pPr}${run}</w:p>`;
}

describe('parseDocument — text extraction', () => {
  it('extracts text from single run', () => {
    const xml = makeDocXml(makePara({ text: 'PART 1 - GENERAL' }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('PART 1 - GENERAL');
  });

  it('concatenates multiple runs', () => {
    const xml = makeDocXml(`<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p>`);
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.text).toBe('Hello World');
  });

  it('returns empty text for paragraph with no runs', () => {
    const xml = makeDocXml('<w:p><w:pPr/></w:p>');
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.text).toBe('');
  });

  it('decodes XML entities in text', () => {
    const xml = makeDocXml(`<w:p><w:r><w:t>&lt;Insert text here&gt;</w:t></w:r></w:p>`);
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.text).toBe('<Insert text here>');
  });
});

describe('parseDocument — pPr field extraction', () => {
  it('extracts styleId', () => {
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1' }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.styleId).toBe('Heading1');
  });

  it('extracts numId and ilvl from own numPr', () => {
    const xml = makeDocXml(makePara({ text: 'text', numId: 3, ilvl: 2 }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.numId).toBe(3);
    expect(result[0]?.ilvl).toBe(2);
  });

  it('extracts leftIndent', () => {
    const xml = makeDocXml(makePara({ text: 'text', leftIndent: 720 }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.leftIndent).toBe(720);
  });

  it('extracts outlineLvl', () => {
    const xml = makeDocXml(makePara({ text: 'text', outlineLvl: 2 }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.outlineLvl).toBe(2);
  });

  it('detects vanish', () => {
    const xml = makeDocXml(makePara({ text: 'hidden', vanish: true }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.isVanish).toBe(true);
  });

  it('returns isVanish false when no vanish element', () => {
    const xml = makeDocXml(makePara({ text: 'visible' }));
    const result = parseDocument(xml, emptyNumberingMap());
    expect(result[0]?.isVanish).toBe(false);
  });
});

describe('parseDocument — numbering inheritance', () => {
  it('resolves numId/ilvl from style via numberingMap.pStyleToNumId', () => {
    const numMap = {
      ...emptyNumberingMap(),
      pStyleToNumId: new Map([['Heading1', 5]]),
      pStyleToIlvl: new Map([['Heading1', 1]]),
    };
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1' }));
    const result = parseDocument(xml, numMap);
    expect(result[0]?.numId).toBe(5);
    expect(result[0]?.ilvl).toBe(1);
  });

  it('own numPr overrides style-inherited numPr', () => {
    const numMap = {
      ...emptyNumberingMap(),
      pStyleToNumId: new Map([['Heading1', 5]]),
      pStyleToIlvl: new Map([['Heading1', 1]]),
    };
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1', numId: 7, ilvl: 3 }));
    const result = parseDocument(xml, numMap);
    expect(result[0]?.numId).toBe(7);
    expect(result[0]?.ilvl).toBe(3);
  });

  it('throws ParserError for malformed XML', () => {
    expect(() => parseDocument('<not valid xml', emptyNumberingMap())).toThrow();
  });
});
