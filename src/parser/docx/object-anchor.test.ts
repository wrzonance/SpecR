import { describe, it, expect } from 'vitest';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';
import { wrapWithControl } from '../../generator/controls.js';
import { createOrderedDocumentXmlBuilder } from './xml-utils.js';
import { wrapBlobParagraphWithAnchor } from './object-anchor.js';
import type { ObjectBlobNode } from '../../ast/index.js';

const UUID_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const UUID_B = '11111111-2222-3333-4444-555555555555';

function paragraphBlob(text: string): ObjectBlobNode {
  return { 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] };
}

/** Reserializes a wrapped blob node to XML, the same round-trip WS2 will use. */
function toXml(node: ObjectBlobNode): string {
  return createOrderedDocumentXmlBuilder().build([node]);
}

/** Every `<w:tag w:val="...">` occurrence in an XML string, in document order. */
function tagValues(xml: string): readonly string[] {
  return [...xml.matchAll(/<w:tag w:val="([^"]*)"/g)].map((m) => m[1] ?? '');
}

/** Renders generator/controls.ts's SdtBlock through a real docx.js Document/Packer,
 * mirroring header-footer-images.test.ts's own renderToZip pattern — the only way to
 * observe its actual emitted w:tag value (it's an opaque XmlComponent otherwise). */
async function controlsTagXml(uuid: string): Promise<string> {
  const para = new Paragraph({ children: [new TextRun('hello')] });
  const sdt = wrapWithControl(para, uuid);
  const doc = new Document({ sections: [{ children: [sdt] }] });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const file = zip.file('word/document.xml');
  return file ? file.async('text') : Promise.resolve('');
}

describe('wrapBlobParagraphWithAnchor — anchor uniqueness and sole-locator', () => {
  it('produces a w:sdt whose w:tag value is exactly one occurrence of UUID_TAG_PREFIX + uuid', () => {
    const wrapped = wrapBlobParagraphWithAnchor(paragraphBlob('hello'), UUID_A);
    const values = tagValues(toXml(wrapped));
    expect(values).toEqual([`specr-uuid-${UUID_A}`]);
  });

  it('gives two distinct paragraphs distinct, non-colliding anchor tags', () => {
    const wrappedA = wrapBlobParagraphWithAnchor(paragraphBlob('a'), UUID_A);
    const wrappedB = wrapBlobParagraphWithAnchor(paragraphBlob('b'), UUID_B);
    const [tagA] = tagValues(toXml(wrappedA));
    const [tagB] = tagValues(toXml(wrappedB));
    expect(tagA).not.toBe(tagB);
    expect(tagA).toBe(`specr-uuid-${UUID_A}`);
    expect(tagB).toBe(`specr-uuid-${UUID_B}`);
  });

  it('is the SOLE locator: the wrapped paragraph carries no separate blobPath/index field, only the w:tag', () => {
    const wrapped = wrapBlobParagraphWithAnchor(paragraphBlob('hello'), UUID_A);
    expect(Object.keys(wrapped)).toEqual(['w:sdt']);
  });

  it("objectText non-emptiness precondition: preserves the paragraph's own text verbatim as w:sdtContent — wrapping never drops or rewrites it, so the objectText node extracted from this anchor downstream (#300 struct 4) is never empty", () => {
    const paragraph = paragraphBlob('preserved text');
    const wrapped = wrapBlobParagraphWithAnchor(paragraph, UUID_A);
    const rebuilt = toXml(wrapped);
    expect(rebuilt).toContain('<w:t>preserved text</w:t>');
  });

  it('objectText non-emptiness precondition: an empty-text paragraph stays exactly as empty (never invented, never silently dropped) — downstream text extraction, not this wrapper, is what must reject an empty objectText', () => {
    const emptyParagraph = paragraphBlob('');
    const wrapped = wrapBlobParagraphWithAnchor(emptyParagraph, UUID_A);
    expect(toXml(wrapped)).toContain('<w:t/>');
  });

  it('never mutates the input paragraph node', () => {
    const paragraph = paragraphBlob('untouched');
    const before = JSON.parse(JSON.stringify(paragraph)) as unknown;
    wrapBlobParagraphWithAnchor(paragraph, UUID_A);
    expect(JSON.parse(JSON.stringify(paragraph))).toEqual(before);
  });

  it('cross-check: emits the identical w:tag value generator/controls.ts wrapWithControl emits for the same uuid', async () => {
    const controlsXml = await controlsTagXml(UUID_A);
    const wrapped = wrapBlobParagraphWithAnchor(paragraphBlob('hello'), UUID_A);
    expect(tagValues(toXml(wrapped))).toEqual(tagValues(controlsXml));
  });
});
