// True cross-module round trip for a manual page break (#497, ADR-075): a
// hand-authored source .docx carrying a `w:br w:type="page"` run at the end
// of one paragraph is (1) parsed into a SpecTree where the flag lands on the
// FOLLOWING node as `meta.pageBreakBefore` (parser/docx/document.ts's
// lookback + parser/docx/inference.ts's pageBreakMeta), then (2) regenerated
// into a fresh .docx from that tree (generator/index.ts's simpleParagraph /
// numberedParagraph). Every other #497 suite tests one side of this boundary
// in isolation (parser/docx/document.test.ts and inference.test.ts feed the
// capture path hand-written XML; generator/index.test.ts feeds the generator
// a hand-written SpecNode with meta.pageBreakBefore already set) — neither
// proves the parser's own capture and the generator's own re-emission agree
// on which node the flag lands on. Per CLAUDE.md's module-boundary rule this
// file lives in src/parser/docx/ (same module as the capture path it
// exercises) and reaches the generator only through its public barrel
// (../../generator/index.js).

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parse } from '../index.js';
import { generateDocx } from '../../generator/index.js';
import type { SpecNode, SpecTree } from '../../ast/types.js';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const MINIMAL_STYLES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';

function makeDocumentXml(bodyXml: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}>` +
    `<w:body>${bodyXml}</w:body></w:document>`
  );
}

async function makeDocx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('word/styles.xml', MINIMAL_STYLES);
  zip.file('word/document.xml', makeDocumentXml(bodyXml));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function para(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

// A page break run appended to the same paragraph as its preceding text —
// the shape a real Word "Insert Page Break" produces: the break run trails
// the last text run of the paragraph it follows, never starting a paragraph
// of its own.
function paraWithTrailingPageBreak(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r>` + '<w:r><w:br w:type="page"/></w:r></w:p>';
}

function flatten(nodes: readonly SpecNode[]): SpecNode[] {
  return [...nodes, ...nodes.flatMap((n) => flatten(n.children))];
}

async function generatedDocumentXml(tree: SpecTree): Promise<string> {
  const buffer = await generateDocx(tree);
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('generated docx has no word/document.xml');
  return doc.async('string');
}

describe('manual page break round trip — parse -> generate (#497, ADR-075)', () => {
  it('carries meta.pageBreakBefore onto the node FOLLOWING the source w:br, never the node containing it', async () => {
    const source = await makeDocx(
      paraWithTrailingPageBreak('Paragraph one text.') + para('Paragraph two text.')
    );
    const { tree } = await parse(source, 'source.docx');
    const nodes = flatten(tree.parts);

    const first = nodes.find((n) => n.text === 'Paragraph one text.');
    const second = nodes.find((n) => n.text === 'Paragraph two text.');
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // The break lives in paragraph one's own runs — it must NOT mark itself.
    expect(first?.meta.pageBreakBefore).toBeUndefined();
    // It must mark the paragraph that follows it.
    expect(second?.meta.pageBreakBefore).toBe(true);
  });

  it("re-emits the carried flag as w:pageBreakBefore on the SECOND paragraph's w:pPr, not the first", async () => {
    const source = await makeDocx(
      paraWithTrailingPageBreak('Paragraph one text.') + para('Paragraph two text.')
    );
    const { tree } = await parse(source, 'source.docx');
    const xml = await generatedDocumentXml(tree);

    const paragraphs = xml.match(/<w:p>(?:(?!<w:p>).)*?<\/w:p>/gs) ?? [];
    const firstPara = paragraphs.find((p) => p.includes('Paragraph one text.'));
    const secondPara = paragraphs.find((p) => p.includes('Paragraph two text.'));
    expect(firstPara).toBeDefined();
    expect(secondPara).toBeDefined();

    expect(firstPara).not.toContain('<w:pageBreakBefore/>');
    expect(secondPara).toContain('<w:pageBreakBefore/>');
  });

  it('KNOWN AMBIGUITY: a trailing page break with no following paragraph is silently dropped (no node to attach it to)', async () => {
    const source = await makeDocx(paraWithTrailingPageBreak('Last paragraph text.'));
    const { tree } = await parse(source, 'source.docx');
    const nodes = flatten(tree.parts);
    const last = nodes.find((n) => n.text === 'Last paragraph text.');

    expect(last).toBeDefined();
    expect(last?.meta.pageBreakBefore).toBeUndefined();

    const xml = await generatedDocumentXml(tree);
    expect(xml).not.toContain('<w:pageBreakBefore/>');
  });

  it('a plain document with no w:br carries no pageBreakBefore anywhere, and re-emits none', async () => {
    const source = await makeDocx(para('Only paragraph, no break.'));
    const { tree } = await parse(source, 'source.docx');
    const nodes = flatten(tree.parts);

    expect(nodes.some((n) => n.meta.pageBreakBefore === true)).toBe(false);

    const xml = await generatedDocumentXml(tree);
    expect(xml).not.toContain('<w:pageBreakBefore/>');
  });

  // #497 review finding: an empty spacer paragraph between the break and the next
  // real paragraph previously swallowed the flag entirely (buildTree's content
  // pre-filter drops a blank paragraph before it ever reaches makeContinuationNode).
  it('carries pageBreakBefore past an intervening blank/empty spacer paragraph onto the next real paragraph', async () => {
    const source = await makeDocx(
      paraWithTrailingPageBreak('Paragraph one text.') + para('') + para('Paragraph two text.')
    );
    const { tree } = await parse(source, 'source.docx');
    const nodes = flatten(tree.parts);

    const first = nodes.find((n) => n.text === 'Paragraph one text.');
    const second = nodes.find((n) => n.text === 'Paragraph two text.');
    expect(first?.meta.pageBreakBefore).toBeUndefined();
    expect(second?.meta.pageBreakBefore).toBe(true);

    const xml = await generatedDocumentXml(tree);
    const paragraphs = xml.match(/<w:p>(?:(?!<w:p>).)*?<\/w:p>/gs) ?? [];
    const secondPara = paragraphs.find((p) => p.includes('Paragraph two text.'));
    expect(secondPara).toContain('<w:pageBreakBefore/>');
  });

  it('KNOWN AMBIGUITY: a page break immediately before a body-level table (#300, ADR-072) is dropped, never misattached to the paragraph after the table', async () => {
    const table =
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const source = await makeDocx(
      paraWithTrailingPageBreak('Paragraph before table.') + table + para('Paragraph after table.')
    );
    const { tree } = await parse(source, 'source.docx');
    const nodes = flatten(tree.parts);

    const before = nodes.find((n) => n.text === 'Paragraph before table.');
    const after = nodes.find((n) => n.text === 'Paragraph after table.');
    const table_ = nodes.find((n) => n.type === 'object');
    expect(before?.meta.pageBreakBefore).toBeUndefined();
    expect(table_?.meta.pageBreakBefore).toBeUndefined();
    // Misattributed by document.ts's raw <w:p>-only lookback (it never sees the
    // interleaved w:tbl) — dropped rather than incorrectly landing here.
    expect(after?.meta.pageBreakBefore).toBeUndefined();

    const xml = await generatedDocumentXml(tree);
    expect(xml).not.toContain('<w:pageBreakBefore/>');
  });
});
