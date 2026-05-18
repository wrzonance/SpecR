import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseDocx } from './index.js';
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
  omitDocument?: boolean;
  omitStyles?: boolean;
}): Promise<Buffer> {
  const zip = new JSZip();
  if (!opts.omitStyles) zip.file('word/styles.xml', opts.stylesXml ?? MINIMAL_STYLES);
  if (!opts.omitDocument) zip.file('word/document.xml', opts.documentXml ?? MINIMAL_DOC);
  if (opts.numberingXml) zip.file('word/numbering.xml', opts.numberingXml);
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
