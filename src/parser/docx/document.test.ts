import { describe, it, expect } from 'vitest';
import { parseDocument } from './document.js';
import { emptyNumberingMap } from './numbering.js';
import { buildStyleMap } from './styles.js';

function makeDocXml(paragraphs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
}

const EMPTY_STYLES = buildStyleMap(
  `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
);

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
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('PART 1 - GENERAL');
  });

  it('concatenates multiple runs', () => {
    const xml = makeDocXml(`<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p>`);
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('Hello World');
  });

  it('returns empty text for paragraph with no runs', () => {
    const xml = makeDocXml('<w:p><w:pPr/></w:p>');
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('');
  });

  it('decodes XML entities in text', () => {
    const xml = makeDocXml(`<w:p><w:r><w:t>&lt;Insert text here&gt;</w:t></w:r></w:p>`);
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('<Insert text here>');
  });

  // Regression (#120): Word splits a number like "09 91 26" across runs at
  // edit/rsid boundaries. A run whose text is a bare integer ("9") was coerced
  // to a JS number by fast-xml-parser and dropped — corrupting "09 91 26" → "09 1 26".
  it('preserves a bare-integer run split across a number (#120: numeric run drop)', () => {
    const xml = makeDocXml(
      `<w:p><w:r><w:t xml:space="preserve">09 </w:t></w:r>` +
        `<w:r><w:t>9</w:t></w:r>` +
        `<w:r><w:t xml:space="preserve">1 26</w:t></w:r></w:p>`
    );
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.text).toBe('09 91 26');
  });
});

describe('parseDocument — pPr field extraction', () => {
  it('extracts styleId', () => {
    const xml = makeDocXml(makePara({ text: 'text', styleId: 'Heading1' }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.styleId).toBe('Heading1');
  });

  it('extracts numId and ilvl from own numPr', () => {
    const xml = makeDocXml(makePara({ text: 'text', numId: 3, ilvl: 2 }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.numId).toBe(3);
    expect(result[0]?.ilvl).toBe(2);
  });

  it('extracts leftIndent', () => {
    const xml = makeDocXml(makePara({ text: 'text', leftIndent: 720 }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.leftIndent).toBe(720);
  });

  it('extracts outlineLvl', () => {
    const xml = makeDocXml(makePara({ text: 'text', outlineLvl: 2 }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.outlineLvl).toBe(2);
  });

  it('detects vanish', () => {
    const xml = makeDocXml(makePara({ text: 'hidden', vanish: true }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.isVanish).toBe(true);
  });

  it('returns isVanish false when no vanish element', () => {
    const xml = makeDocXml(makePara({ text: 'visible' }));
    const result = parseDocument(xml, emptyNumberingMap(), EMPTY_STYLES);
    expect(result[0]?.isVanish).toBe(false);
  });

  it('detects vanish from all-runs-hidden even without paragraph-mark vanish', () => {
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
    );
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r></w:p>
  </w:body></w:document>`;
    const paras = parseDocument(xml, emptyNumberingMap(), styles);
    expect(paras[0]?.isVanish).toBe(true);
  });

  it('detects vanish inherited from the paragraph style', () => {
    const styles =
      buildStyleMap(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:styleId="Hidden" w:type="paragraph"><w:name w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`);
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Hidden"/></w:pPr><w:r><w:t>via style</w:t></w:r></w:p>
  </w:body></w:document>`;
    expect(parseDocument(xml, emptyNumberingMap(), styles)[0]?.isVanish).toBe(true);
  });

  it('does NOT mark vanish when only some runs are hidden', () => {
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
    );
    // KNOWN AMBIGUITY: a paragraph with a mix of hidden and visible runs is treated
    // as VISIBLE — the visible text is real content; only fully-hidden paragraphs drop out.
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r><w:r><w:t>visible</w:t></w:r></w:p>
  </w:body></w:document>`;
    expect(parseDocument(xml, emptyNumberingMap(), styles)[0]?.isVanish).toBe(false);
  });

  it('detects vanish when runs are wrapped in an OOXML container (w:sdt) (Codex #295)', () => {
    // SpecR's own generator wraps runs in w:sdt UUID anchors; a fully-hidden wrapped
    // paragraph must still be detected as hidden, not misread as visible.
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
    );
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:sdt><w:sdtContent><w:r><w:rPr><w:vanish/></w:rPr><w:t>wrapped hidden</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body></w:document>`;
    expect(parseDocument(xml, emptyNumberingMap(), styles)[0]?.isVanish).toBe(true);
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
    const result = parseDocument(xml, numMap, EMPTY_STYLES);
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
    const result = parseDocument(xml, numMap, EMPTY_STYLES);
    expect(result[0]?.numId).toBe(7);
    expect(result[0]?.ilvl).toBe(3);
  });

  it('throws ParserError for malformed XML', () => {
    expect(() => parseDocument('<not valid xml', emptyNumberingMap(), EMPTY_STYLES)).toThrow();
  });
});
