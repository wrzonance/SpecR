import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseDocx } from './index.js';
import { parse } from '../index.js';
import type { SpecNode } from '../../ast/types.js';

const MINIMAL_STYLES = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;

const MINIMAL_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Plain paragraph text.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const STRUCTURED_NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="multilevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="PART %1"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%2"/></w:lvl>
    <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%3."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const STRUCTURED_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>SUMMARY</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Includes work.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Continuation paragraph text here.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

async function makeDocx(opts: {
  documentXml?: string;
  stylesXml?: string;
  numberingXml?: string;
  coreXml?: string;
  omitDocument?: boolean;
  omitStyles?: boolean;
}): Promise<Buffer> {
  const zip = new JSZip();
  if (!opts.omitStyles) zip.file('word/styles.xml', opts.stylesXml ?? MINIMAL_STYLES);
  if (!opts.omitDocument) zip.file('word/document.xml', opts.documentXml ?? MINIMAL_DOC);
  if (opts.numberingXml) zip.file('word/numbering.xml', opts.numberingXml);
  if (opts.coreXml) zip.file('docProps/core.xml', opts.coreXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const ARCAT_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:styleId="ARCATArticle" w:type="paragraph">
    <w:name w:val="ARCATArticle"/>
    <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
  </w:style>
</w:styles>`;

const CORE_XML = `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:subject>27 21 00</dc:subject>
  <dc:title>Structured Cabling</dc:title>
</cp:coreProperties>`;

function flatTypes(nodes: readonly SpecNode[]): string[] {
  return [...nodes.flatMap((n) => [n.type, ...flatTypes(n.children)])];
}

describe('parseDocx — happy path', () => {
  it('parses minimal DOCX without numbering', async () => {
    const buffer = await makeDocx({});
    const tree = await parseDocx(buffer);
    expect(tree.parts.length).toBeGreaterThan(0);
  });

  it('parses structured DOCX with numbering — produces part/article/pr1/continuation', async () => {
    const buffer = await makeDocx({
      numberingXml: STRUCTURED_NUMBERING,
      documentXml: STRUCTURED_DOC,
    });
    const tree = await parseDocx(buffer);
    const types = flatTypes(tree.parts);
    expect(types).toContain('part');
    expect(types).toContain('article');
    expect(types).toContain('pr1');
    expect(types).toContain('continuation');
    // source='unknown' — synthetic styles.xml has no ARCAT/CPI style names
    expect(tree.parts[0]?.meta.source).toBe('unknown');
  });

  it('calls onProgress at each stage', async () => {
    const stages: string[] = [];
    const buffer = await makeDocx({});
    await parseDocx(buffer, (stage) => stages.push(stage));
    expect(stages).toEqual([
      'extracting',
      'numbering',
      'styles',
      'document',
      'classifying',
      'complete',
    ]);
  });
});

describe('parseDocx — error handling', () => {
  it('throws ParserError for corrupt buffer', async () => {
    await expect(parseDocx(Buffer.from('not a zip'))).rejects.toThrow(
      'failed to read DOCX archive'
    );
  });

  it('throws ParserError when word/styles.xml missing', async () => {
    const buffer = await makeDocx({ omitStyles: true });
    await expect(parseDocx(buffer)).rejects.toThrow('DOCX missing word/styles.xml');
  });

  it('throws ParserError when word/document.xml missing', async () => {
    const buffer = await makeDocx({ omitDocument: true });
    await expect(parseDocx(buffer)).rejects.toThrow('DOCX missing word/document.xml');
  });

  it('throws ParserError for document with no w:p elements', async () => {
    // A body with only w:sectPr (no paragraphs) → parseDocument returns [] → throws
    const noParagraphsDoc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sectPr/></w:body></w:document>`;
    const buffer = await makeDocx({ documentXml: noParagraphsDoc });
    await expect(parseDocx(buffer)).rejects.toThrow('document contains no paragraphs');
  });

  it('detects source=arcat when ARCAT-prefixed styles present', async () => {
    const buffer = await makeDocx({ stylesXml: ARCAT_STYLES });
    const tree = await parseDocx(buffer);
    expect(tree.parts[0]?.meta.source).toBe('arcat');
  });

  it('extracts section/title from docProps/core.xml when present', async () => {
    const zip = new JSZip();
    zip.file('word/styles.xml', MINIMAL_STYLES);
    zip.file('word/document.xml', MINIMAL_DOC);
    zip.file('docProps/core.xml', CORE_XML);
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('27 21 00');
    expect(tree.title).toBe('Structured Cabling');
  });

  it('uses unknown for section/title when docProps absent', async () => {
    const buffer = await makeDocx({});
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('unknown');
    expect(tree.title).toBe('unknown');
  });
});

describe('parseDocx — dc:subject section normalization (#gate)', () => {
  function coreWith(subject: string): string {
    return `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:subject>${subject}</dc:subject>
  <dc:title>Structured Cabling</dc:title>
</cp:coreProperties>`;
  }

  it('degrades free-text dc:subject to unknown (does not leak prose as section)', async () => {
    const buffer = await makeDocx({ coreXml: coreWith('Division 26 - Electrical') });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('unknown');
  });

  it('keeps a conforming dc:subject section number', async () => {
    const buffer = await makeDocx({ coreXml: coreWith('26 00 13.10') });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('26 00 13.10');
  });

  it('normalizes a dirty (multi-space) dc:subject section number', async () => {
    const buffer = await makeDocx({ coreXml: coreWith('26  00 13.10') });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('26 00 13.10');
  });

  it('normalizes a display-variant dc:subject section number', async () => {
    const buffer = await makeDocx({ coreXml: coreWith('09.91.00') });
    const tree = await parseDocx(buffer);
    expect(tree.section).toBe('09 91 00');
  });
});

// ── ARCAT-realistic end-to-end: numbering-generated PART prefixes, style-only
//    part linkage (reverse pStyle), preamble, specifier notes, no core.xml ──

const ARCAT_E2E_NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:pStyle w:val="ARCATPart"/><w:lvlText w:val="PART  %1"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:pStyle w:val="ARCATArticle"/><w:lvlText w:val="%1.%2"/></w:lvl>
    <w:lvl w:ilvl="2"><w:numFmt w:val="upperLetter"/><w:pStyle w:val="ARCATParagraph"/><w:lvlText w:val="%3."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const ARCAT_E2E_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:styleId="ARCATPart" w:type="paragraph"><w:name w:val="ARCATPart"/></w:style>
  <w:style w:styleId="ARCATArticle" w:type="paragraph">
    <w:name w:val="ARCATArticle"/>
    <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
  </w:style>
  <w:style w:styleId="ARCATParagraph" w:type="paragraph">
    <w:name w:val="ARCATParagraph"/>
    <w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr></w:pPr>
  </w:style>
  <w:style w:styleId="ARCATnote" w:type="paragraph"><w:name w:val="ARCATnote"/></w:style>
  <w:style w:styleId="ARCATTitle" w:type="paragraph"><w:name w:val="ARCATTitle"/></w:style>
</w:styles>`;

function p(style: string | null, text: string): string {
  const pr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

const ARCAT_E2E_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${p('ARCATTitle', 'SECTION 21 11 00')}
    ${p('ARCATTitle', 'FIRE SPRINKLER FITTINGS AND VALVES')}
    ${p('ARCATTitle', 'Copyright 2018 - 2019 ARCAT, Inc. - All rights reserved')}
    ${p('ARCATnote', '** NOTE TO SPECIFIER ** AGF Manufacturing; delete options not required.')}
    ${p('ARCATPart', 'GENERAL')}
    ${p('ARCATArticle', 'SECTION INCLUDES')}
    ${p('ARCATParagraph', 'Fire sprinkler fittings and valves.')}
    ${p('ARCATPart', 'PRODUCTS')}
    ${p('ARCATArticle', 'MANUFACTURERS')}
    ${p('ARCATPart', 'EXECUTION')}
    ${p('ARCATArticle', 'INSTALLATION')}
  </w:body>
</w:document>`;

describe('parseDocx — ARCAT-realistic regression (21 11 00: 34 parts instead of 3)', () => {
  async function parseArcatE2e() {
    const buffer = await makeDocx({
      documentXml: ARCAT_E2E_DOC,
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
    });
    return parseDocx(buffer);
  }

  it('classifies numbering-generated PART headings: exactly 3 part-type roots', async () => {
    const tree = await parseArcatE2e();
    const partRoots = tree.parts.filter((n) => n.type === 'part');
    expect(partRoots.map((n) => n.text)).toEqual(['GENERAL', 'PRODUCTS', 'EXECUTION']);
  });

  it('articles nest under their parts, not as roots', async () => {
    const tree = await parseArcatE2e();
    const general = tree.parts.find((n) => n.text === 'GENERAL');
    expect(
      general?.children.some((c) => c.type === 'article' && c.text === 'SECTION INCLUDES')
    ).toBe(true);
  });

  it('parse() orchestrator infers section/title from content when core.xml is absent', async () => {
    const buffer = await makeDocx({
      documentXml: ARCAT_E2E_DOC,
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
    });
    const result = await parse(buffer, 'arcat-e2e.docx');
    expect(result.sectionInference.method).toBe('content-high');
    expect(result.tree.section).toBe('21 11 00');
    expect(result.tree.title).toBe('FIRE SPRINKLER FITTINGS AND VALVES');
  });

  it('parse() orchestrator normalizes compact SECTION display from DOCX content', async () => {
    const buffer = await makeDocx({
      documentXml: ARCAT_E2E_DOC.replace('SECTION 21 11 00', 'SECTION 099100 - PAINTING'),
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
    });
    const result = await parse(buffer, 'arcat-e2e.docx');
    expect(result.sectionInference.method).toBe('content-high');
    expect(result.tree.section).toBe('09 91 00');
    expect(result.tree.title).toBe('PAINTING');
  });

  it('parseDocx alone leaves section unknown — inference belongs to the orchestrator', async () => {
    const tree = await parseArcatE2e();
    expect(tree.section).toBe('unknown');
  });

  it('specifier-note banner becomes a vanish note, not a bare continuation', async () => {
    const tree = await parseArcatE2e();
    const all = (ns: readonly SpecNode[]): SpecNode[] => [
      ...ns,
      ...ns.flatMap((n) => all(n.children)),
    ];
    const note = all(tree.parts).find((n) => n.text.startsWith('** NOTE TO SPECIFIER **'));
    expect(note?.type).toBe('note');
    expect(note?.meta.vanish).toBe(true);
  });

  it('emits root-continuation warning for preamble junk roots, but no unusual-part-count', async () => {
    const tree = await parseArcatE2e();
    const types = (tree.warnings ?? []).map((w) => w.type);
    expect(types).toContain('root-continuation');
    expect(types).not.toContain('unusual-part-count');
    expect(types).not.toContain('no-structure-found');
  });

  it('core.xml metadata still wins over content inference when present', async () => {
    const buffer = await makeDocx({
      documentXml: ARCAT_E2E_DOC,
      stylesXml: ARCAT_E2E_STYLES,
      numberingXml: ARCAT_E2E_NUMBERING,
      coreXml: CORE_XML,
    });
    const result = await parse(buffer, 'arcat-e2e.docx');
    expect(result.sectionInference.method).toBe('metadata');
    expect(result.tree.section).toBe('27 21 00');
    expect(result.tree.title).toBe('Structured Cabling');
  });
});
