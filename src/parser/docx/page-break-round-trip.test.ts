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

// A paragraph carrying the OTHER real source form of a manual page break: the
// paragraph-level `w:pageBreakBefore` property, produced by Word's Paragraph
// dialog → "Line and Page Breaks" → "Page break before" (and set by many
// heading styles). Unlike the run-level w:br, the break lives ON the paragraph
// that begins the new page, not in the one before it.
function paraWithOwnPageBreak(text: string): string {
  return `<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
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

  // #497 review finding: a source Word doc can express the SAME manual page break
  // as a paragraph-level `w:pageBreakBefore` property (Paragraph dialog / heading
  // style) instead of a run-level `w:br` in the preceding paragraph. The parser
  // must capture that form too, and it must land on the paragraph that carries it
  // — not shifted onto a neighbour like the run-level form. This proves the own-
  // property capture and the generator's re-emission agree on the same node.
  //
  // NOTE this exercises the capture form directly from a source paragraph, NOT a
  // re-import of SpecR's own generated .docx: the generator wraps every content
  // paragraph in a `w:sdt` UUID merge anchor, and `parse()` reads only direct
  // `w:body/w:p` children — so a generated .docx is re-integrated through the
  // UUID-anchored merge engine, never re-parsed into a fresh tree (that is not a
  // supported flow, page break or otherwise).
  it('round-trips a source paragraph-level w:pageBreakBefore property (Word "Page break before") through parse -> generate', async () => {
    const source = await makeDocx(
      para('Paragraph one text.') + paraWithOwnPageBreak('Paragraph two text.')
    );
    const { tree } = await parse(source, 'source.docx');
    const nodes = flatten(tree.parts);

    const first = nodes.find((n) => n.text === 'Paragraph one text.');
    const second = nodes.find((n) => n.text === 'Paragraph two text.');
    // The break lives ON paragraph two — it must mark itself, never its predecessor.
    expect(first?.meta.pageBreakBefore).toBeUndefined();
    expect(second?.meta.pageBreakBefore).toBe(true);

    // And it re-emits as `w:pageBreakBefore` on that same paragraph on generate.
    const xml = await generatedDocumentXml(tree);
    const paragraphs = xml.match(/<w:p>(?:(?!<w:p>).)*?<\/w:p>/gs) ?? [];
    const firstPara = paragraphs.find((p) => p.includes('Paragraph one text.'));
    const secondPara = paragraphs.find((p) => p.includes('Paragraph two text.'));
    expect(firstPara).not.toContain('<w:pageBreakBefore/>');
    expect(secondPara).toContain('<w:pageBreakBefore/>');
  });

  // KNOWN AMBIGUITY: pageBreakBefore is a property of the paragraph AFTER the
  // break — a w:br at the very end of the document has no following paragraph,
  // so there is no node to carry the flag and the break is dropped on parse.
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

  // KNOWN AMBIGUITY: document.ts's page-break lookback walks the raw <w:p>-only
  // array and never sees an interleaved w:tbl, so the break is misattributed to
  // the paragraph after the table; an object node has no pageBreakBefore
  // attachment point (ADR-072/075), so the flag is dropped rather than landing
  // on a paragraph the break never preceded.
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

  // #497 review finding: a paragraph's OWN w:pageBreakBefore property is intrinsic
  // to it — never a misattribution — so unlike the predecessor-w:br form above it
  // must SURVIVE an interposed body object. (The predecessor-lookback form is
  // dropped across a table because document.ts's w:p-only lookback can't see the
  // interleaved w:tbl; the own-property form has no such blindness.)
  it("keeps a paragraph's OWN w:pageBreakBefore even when a body-level table sits immediately before it", async () => {
    const table =
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const source = await makeDocx(
      para('Paragraph before table.') + table + paraWithOwnPageBreak('Paragraph after table.')
    );
    const { tree } = await parse(source, 'source.docx');
    const nodes = flatten(tree.parts);

    const after = nodes.find((n) => n.text === 'Paragraph after table.');
    expect(after?.meta.pageBreakBefore).toBe(true);

    const xml = await generatedDocumentXml(tree);
    const paragraphs = xml.match(/<w:p>(?:(?!<w:p>).)*?<\/w:p>/gs) ?? [];
    const afterPara = paragraphs.find((p) => p.includes('Paragraph after table.'));
    expect(afterPara).toContain('<w:pageBreakBefore/>');
  });

  // #497 review finding: a hidden non-note paragraph becomes a meta.vanish node the
  // generator drops entirely (#296). A page break landing on it would vanish with
  // it, so the break must forward to the next ACTUALLY-emitted node instead.
  it('forwards a page break past a hidden non-note paragraph onto the next visible node', async () => {
    const hidden = '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden text</w:t></w:r></w:p>';
    const source = await makeDocx(
      paraWithTrailingPageBreak('Visible one.') + hidden + para('Visible two.')
    );
    const { tree } = await parse(source, 'source.docx');
    const nodes = flatten(tree.parts);

    const hiddenNode = nodes.find((n) => n.text === 'hidden text');
    const visibleTwo = nodes.find((n) => n.text === 'Visible two.');
    expect(hiddenNode?.meta.vanish).toBe(true);
    // The break must NOT rest on the dropped hidden node — it lands on the next
    // emitted node.
    expect(hiddenNode?.meta.pageBreakBefore).toBeUndefined();
    expect(visibleTwo?.meta.pageBreakBefore).toBe(true);

    const xml = await generatedDocumentXml(tree);
    // Exactly one break survives to the generated doc — not zero (swallowed by the
    // hidden node), not two.
    expect((xml.match(/<w:pageBreakBefore\/>/g) ?? []).length).toBe(1);
    const paragraphs = xml.match(/<w:p>(?:(?!<w:p>).)*?<\/w:p>/gs) ?? [];
    const visibleTwoPara = paragraphs.find((p) => p.includes('Visible two.'));
    expect(visibleTwoPara).toContain('<w:pageBreakBefore/>');
  });
});
