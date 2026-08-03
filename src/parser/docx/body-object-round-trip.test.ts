// True cross-module round trip for captured body objects (#517, WS2 task
// 5/7): a hand-authored source .docx is (1) parsed into a SpecTree carrying
// `object` nodes (parser/docx/body-object-attach.ts), (2) regenerated into a
// fresh .docx from that tree (generator/index.ts's emitNode 'object' branch +
// object-block.ts's buildObjectBlocks), then (3) re-parsed. Every other #517
// suite tests one side of this boundary in isolation
// (alternate-content.test.ts / body-objects.test.ts feed the capture path
// hand-written XML; generator/index.test.ts / generator/object-block.test.ts
// feed the generator a hand-written SpecNode) — neither proves the
// generator's actual re-emitted OOXML is something the parser's own capture
// path can read back. Per CLAUDE.md's module-boundary rule this file lives
// in src/parser/docx/ (same module as the capture path it exercises) and
// reaches the generator only through its public barrel (../../generator/index.js).
//
// Pinned invariants (never node identity — a fresh uuid is minted on every
// capture, so `id` is deliberately excluded; see the KNOWN AMBIGUITY note
// on the last describe block below):
//   1. Round-trip conservation: N object nodes of a given kind survive as N
//      object nodes of the same kind, with the same objectText count/text.
//   2. A VML-only captured object is never coerced into DrawingML by the
//      round trip (generation metadata is preserved), and vice versa.
//   3. A cell paragraph whose text starts with a numeral-dot prefix is never
//      reclassified as a pr-tier node after round-tripping.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parse, replaceAnchoredParagraphText } from '../index.js';
import { generateDocx } from '../../generator/index.js';
import type { SpecNode, SpecTree } from '../../ast/types.js';
import type { ObjectBlobNode } from '../../ast/index.js';

// Root namespaces a real Word <w:document> declares — the wordprocessing +
// wordprocessingDrawing/Shape, VML, and markup-compatibility set docx@9.7.1
// also declares on its generated root (verified against the installed
// dependency). DrawingML core (`xmlns:a`) is DELIBERATELY absent here: Word
// (and docx itself) declare it INLINE on the <a:graphic> element, never on
// the document root — so the DrawingML text-box fixture below carries its own
// inline xmlns:a exactly as Word emits it. This is what keeps the re-emitted
// blob namespace-valid on the round trip: the captured subtree carries the
// binding for every prefix it uses (see the namespace-validity test below).
const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
].join(' ');

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

function cell(paragraphsXml: string): string {
  return `<w:tc>${paragraphsXml}</w:tc>`;
}

function row(cellsXml: string): string {
  return `<w:tr>${cellsXml}</w:tr>`;
}

function table(rowsXml: string): string {
  return `<w:tbl>${rowsXml}</w:tbl>`;
}

// A floating (wp:anchor) DrawingML text box wrapped in mc:AlternateContent —
// the realistic shape Word emits for a modern text box (mirrors
// body-objects.test.ts's own alternateContentTextBoxParagraph fixture,
// anchor instead of inline so this suite also covers the floating flag).
function floatingAlternateContentTextBoxParagraph(
  choiceText: string,
  fallbackText: string
): string {
  return (
    '<w:p><w:r><mc:AlternateContent>' +
    '<mc:Choice Requires="wps">' +
    '<w:drawing><wp:anchor><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    // xmlns:a declared INLINE on <a:graphic> exactly as Word/docx emit it —
    // NOT on the source root — so the captured blob carries its own binding.
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    para(choiceText) +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:anchor></w:drawing>' +
    '</mc:Choice>' +
    '<mc:Fallback>' +
    '<w:pict><v:shape><v:textbox><w:txbxContent>' +
    para(fallbackText) +
    '</w:txbxContent></v:textbox></v:shape></w:pict>' +
    '</mc:Fallback>' +
    '</mc:AlternateContent></w:r></w:p>'
  );
}

// A VML-only text box (no mc:AlternateContent at all) — the legacy/compat-mode
// shape body-drawings.ts's classifyVml recognizes directly.
function vmlTextBoxParagraph(interiorText: string): string {
  return (
    '<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent>' +
    para(interiorText) +
    '</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>'
  );
}

// One inline DrawingML text-box RUN (no host <w:p> wrapper) whose
// txbxContent holds `interiorXml` verbatim — a building block for
// mixedVisibilityTwoTextBoxParagraph below, mirroring
// body-objects.test.ts's own textBoxRun/hiddenTextBoxRun convention (xmlns:a
// declared INLINE on <a:graphic>, same as floatingAlternateContentTextBoxParagraph
// above, never on the source root).
function textBoxRunXml(docPrId: number, interiorXml: string): string {
  return (
    `<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="${docPrId}"/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    interiorXml +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r>'
  );
}

// #515/ADR-086: ONE host paragraph carrying TWO separate DrawingML text-box
// runs — the FIRST visible, the SECOND hidden via its own interior run's
// `w:rPr>w:vanish` (mirrors body-objects.test.ts's hiddenTextBoxRun). This is
// the shape the fix targets: a hidden SECOND box must never suppress the
// visible FIRST box's interior text (no-suppression) nor leak its own
// interior text into interiorTexts (privacy) — while the HOST paragraph's
// full OOXML, hidden box included, still round-trips byte-for-byte through
// generate + re-parse untouched (ADR-072 decision 1: the opaque
// w:txbxContent subtree is passed through by reference, never reinterpreted).
function mixedVisibilityTwoTextBoxParagraph(visibleText: string, hiddenText: string): string {
  const visibleRun = textBoxRunXml(1, para(visibleText));
  const hiddenInterior = `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${hiddenText}</w:t></w:r></w:p>`;
  const hiddenRun = textBoxRunXml(2, hiddenInterior);
  return `<w:p>${visibleRun}${hiddenRun}</w:p>`;
}

function flatten(nodes: readonly SpecNode[]): SpecNode[] {
  return [...nodes, ...nodes.flatMap((n) => flatten(n.children))];
}

function objectNodesOf(tree: SpecTree): readonly SpecNode[] {
  return flatten(tree.parts).filter((n) => n.type === 'object');
}

function objectTextsOf(node: SpecNode): readonly string[] {
  return node.children.filter((c) => c.type === 'objectText').map((c) => c.text);
}

async function regenerateAndReparse(tree: SpecTree): Promise<SpecTree> {
  const buffer = await generateDocx(tree);
  const result = await parse(buffer, 'roundtrip.docx');
  return result.tree;
}

// The generator's raw output XML — used to assert the re-emitted blob is
// namespace-well-formed, which the parse -> re-parse cycle above can't see
// (fast-xml-parser treats a prefix as an opaque tag string and never rejects
// an unbound one).
async function generatedDocumentXml(tree: SpecTree): Promise<string> {
  const buffer = await generateDocx(tree);
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('generated docx has no word/document.xml');
  return doc.async('string');
}

// Bundles the three ObjectMeta assertions each test below repeats into one
// call — keeps each `it` body's own branch count (eslint `complexity`, which
// counts every `?.` access) well under the repo's cap of 10.
interface ExpectedObjectMeta {
  readonly kind: 'table' | 'textBox';
  readonly generation?: 'drawingml' | 'vml';
  readonly floating?: boolean;
}

function expectObjectMeta(node: SpecNode | undefined, expected: ExpectedObjectMeta): void {
  expect(node?.meta.object?.kind).toBe(expected.kind);
  if (expected.generation !== undefined) {
    expect(node?.meta.object?.generation).toBe(expected.generation);
  }
  if (expected.floating !== undefined) {
    expect(node?.meta.object?.floating).toBe(expected.floating);
  }
}

// ─── #519 WS3 task 2: edit-the-blob round trip helpers ─────────────────────
// These rebuild a SpecTree the same way a real edit caller (WS3's
// db/queries/object-text-edit.ts) would: replace ONE object node's
// `meta.object.blob` via `replaceAnchoredParagraphText`, leaving every other
// node (including the edited object's own `objectText.text` field, see
// below) untouched. Deliberately duplicated in this test file rather than
// imported from production code — no production module needs "find and
// rewrite one object node inside a whole SpecTree"; only this proof does.

function replaceObjectBlobInTree(
  nodes: readonly SpecNode[],
  objectId: string,
  newBlob: readonly ObjectBlobNode[]
): readonly SpecNode[] {
  return nodes.map((node) => {
    if (node.id !== objectId) {
      return { ...node, children: replaceObjectBlobInTree(node.children, objectId, newBlob) };
    }
    if (!node.meta.object) {
      throw new Error(`object node ${objectId} is missing meta.object`);
    }
    // Spread-copy readonly -> mutable at this boundary: ObjectMeta.blob is
    // Zod-inferred as mutable `ObjectBlobNode[]`, while
    // replaceAnchoredParagraphText's return type stays readonly by design
    // (object-blob-edit.ts's own contract) — a future DB write path
    // (WS3b) does the identical spread-copy at its own real mutable boundary.
    return {
      ...node,
      meta: { ...node.meta, object: { ...node.meta.object, blob: [...newBlob] } },
    };
  });
}

/**
 * Rewrites the anchored paragraph identified by `anchorUuid` inside the
 * object node `objectId`'s captured blob to `newText`, returning a BRAND-NEW
 * tree. Deliberately never touches the corresponding `objectText.text`
 * field anywhere in the tree — this is the point of the "interior text
 * reaches the DOCX only through the blob" invariant below: the generator
 * (generator/index.ts's `emitNode` 'object' branch) reads only
 * `meta.object.blob`, never an `objectText` node's own `text`.
 */
function withEditedObjectBlob(
  tree: SpecTree,
  objectId: string,
  anchorUuid: string,
  newText: string
): SpecTree {
  const target = flatten(tree.parts).find((n) => n.id === objectId);
  if (!target?.meta.object) {
    throw new Error(`object node ${objectId} not found, or missing meta.object`);
  }
  const newBlob = replaceAnchoredParagraphText(target.meta.object.blob, anchorUuid, newText);
  if (!newBlob) {
    throw new Error(`anchor ${anchorUuid} not found in object ${objectId}'s blob`);
  }
  return { ...tree, parts: replaceObjectBlobInTree(tree.parts, objectId, newBlob) };
}

describe('body object round trip — parse -> generate -> re-parse (#517, WS2 task 5/7)', () => {
  it('an inline table conserves its object count, kind, and interior cell text', async () => {
    const source = await makeDocx(
      para('Intro paragraph.') + table(row(cell(para('Round-trip table cell text'))))
    );
    const { tree } = await parse(source, 'source.docx');
    const before = objectNodesOf(tree);
    expect(before).toHaveLength(1);
    expectObjectMeta(before[0], { kind: 'table' });
    expect(objectTextsOf(before[0] as SpecNode)).toEqual(['Round-trip table cell text']);

    const reparsedTree = await regenerateAndReparse(tree);
    const after = objectNodesOf(reparsedTree);

    expect(after).toHaveLength(before.length);
    expectObjectMeta(after[0], { kind: 'table' });
    expect(objectTextsOf(after[0] as SpecNode)).toEqual(objectTextsOf(before[0] as SpecNode));
  });

  it('a floating DrawingML text box (mc:AlternateContent) keeps generation/floating and its Choice-only text through the round trip', async () => {
    const source = await makeDocx(
      para('Intro paragraph.') +
        floatingAlternateContentTextBoxParagraph('Choice text kept', 'Stale VML fallback text')
    );
    const { tree } = await parse(source, 'source.docx');
    const before = objectNodesOf(tree);
    expect(before).toHaveLength(1);
    expectObjectMeta(before[0], { kind: 'textBox', generation: 'drawingml', floating: true });
    // #517: the stale mc:Fallback branch never doubles interiorTexts, even on
    // the FIRST capture — this is the regression the fix pins.
    expect(objectTextsOf(before[0] as SpecNode)).toEqual(['Choice text kept']);

    const reparsedTree = await regenerateAndReparse(tree);
    const after = objectNodesOf(reparsedTree);

    expect(after).toHaveLength(1);
    expectObjectMeta(after[0], { kind: 'textBox', generation: 'drawingml', floating: true });
    expect(objectTextsOf(after[0] as SpecNode)).toEqual(['Choice text kept']);
    expect(objectTextsOf(after[0] as SpecNode)).not.toContain('Stale VML fallback text');
  });

  it('a VML-only text box keeps generation:"vml" through the round trip — never coerced into DrawingML', async () => {
    const source = await makeDocx(para('Intro paragraph.') + vmlTextBoxParagraph('VML box text'));
    const { tree } = await parse(source, 'source.docx');
    const before = objectNodesOf(tree);
    expect(before).toHaveLength(1);
    expectObjectMeta(before[0], { kind: 'textBox', generation: 'vml' });

    const reparsedTree = await regenerateAndReparse(tree);
    const after = objectNodesOf(reparsedTree);

    expect(after).toHaveLength(1);
    expectObjectMeta(after[0], { kind: 'textBox', generation: 'vml' });
    expect(objectTextsOf(after[0] as SpecNode)).toEqual(['VML box text']);
  });

  it('a numeral-dot-prefixed table cell ("1. Foo") is never reclassified as a pr-tier node after round-tripping', async () => {
    const source = await makeDocx(para('Intro paragraph.') + table(row(cell(para('1. Foo')))));
    const { tree } = await parse(source, 'source.docx');
    const reparsedTree = await regenerateAndReparse(tree);

    const after = objectNodesOf(reparsedTree);
    expect(after).toHaveLength(1);
    expectObjectMeta(after[0], { kind: 'table' });
    // The captured interior text is verbatim data, never re-inferred: it
    // survives as an objectText leaf under the SAME object, not promoted to
    // a hierarchy node of its own.
    expect(objectTextsOf(after[0] as SpecNode)).toEqual(['1. Foo']);

    const prTierTypes = new Set(['pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7']);
    const promotedToPrTier = flatten(reparsedTree.parts).some(
      (n) => prTierTypes.has(n.type) && n.text === '1. Foo'
    );
    expect(promotedToPrTier).toBe(false);
  });

  // Every test above constructs exactly ONE object node — the stated
  // "N object nodes survive as N object nodes" conservation invariant (see
  // this file's header) was never exercised past N=1, so a cross-object
  // mixup (kind/text swapped between objects) or a dropped/duplicated object
  // would have gone uncaught. These two pin N=2, one mixed-kind and one
  // same-kind (the latter is the harder case: nothing but ORDER distinguishes
  // the two tables, so a merge/reorder bug can't hide behind a kind check).
  it('two DIFFERENT-kind objects (a table and a VML text box) both round-trip without cross-contaminating each other', async () => {
    const source = await makeDocx(
      para('Intro paragraph.') +
        table(row(cell(para('First table cell text')))) +
        para('Middle paragraph.') +
        vmlTextBoxParagraph('Second box text')
    );
    const { tree } = await parse(source, 'source.docx');
    const before = objectNodesOf(tree);
    expect(before).toHaveLength(2);
    expectObjectMeta(before[0], { kind: 'table' });
    expect(objectTextsOf(before[0] as SpecNode)).toEqual(['First table cell text']);
    expectObjectMeta(before[1], { kind: 'textBox', generation: 'vml' });
    expect(objectTextsOf(before[1] as SpecNode)).toEqual(['Second box text']);

    const reparsedTree = await regenerateAndReparse(tree);
    const after = objectNodesOf(reparsedTree);

    expect(after).toHaveLength(2);
    expectObjectMeta(after[0], { kind: 'table' });
    expect(objectTextsOf(after[0] as SpecNode)).toEqual(['First table cell text']);
    expectObjectMeta(after[1], { kind: 'textBox', generation: 'vml' });
    expect(objectTextsOf(after[1] as SpecNode)).toEqual(['Second box text']);
  });

  it('two SAME-kind objects (two tables) both round-trip in order, without merging or duplicating either', async () => {
    const source = await makeDocx(
      para('Intro paragraph.') +
        table(row(cell(para('Table one text')))) +
        para('Middle paragraph.') +
        table(row(cell(para('Table two text'))))
    );
    const { tree } = await parse(source, 'source.docx');
    const before = objectNodesOf(tree);
    expect(before).toHaveLength(2);
    expect(objectTextsOf(before[0] as SpecNode)).toEqual(['Table one text']);
    expect(objectTextsOf(before[1] as SpecNode)).toEqual(['Table two text']);

    const reparsedTree = await regenerateAndReparse(tree);
    const after = objectNodesOf(reparsedTree);

    expect(after).toHaveLength(2);
    expectObjectMeta(after[0], { kind: 'table' });
    expect(objectTextsOf(after[0] as SpecNode)).toEqual(['Table one text']);
    expectObjectMeta(after[1], { kind: 'table' });
    expect(objectTextsOf(after[1] as SpecNode)).toEqual(['Table two text']);
  });

  // The generator re-emits the captured DrawingML blob verbatim, including its
  // <a:graphic> subtree. docx's own generated <w:document> root declares
  // wp/wps/v/mc but NOT xmlns:a, so a re-emitted <a:graphic> would carry an
  // UNBOUND `a:` prefix — a namespace-invalid document Word rejects — UNLESS
  // the captured subtree brought its own binding. Word (and docx) declare
  // xmlns:a inline on <a:graphic>, so capture preserves it and the round trip
  // stays valid; the parse -> re-parse assertions above never catch this
  // because fast-xml-parser tolerates an unbound prefix. This pins it directly.
  //
  // LIMITATION (WS3): a non-Word source that declares a DrawingML namespace
  // ONLY on its <w:document> root (never inline) would lose that binding on
  // capture — WS2 does not hoist root-scoped namespace declarations into the
  // captured subtree. Deferred to WS3's full re-emission-fidelity work.
  it('re-emits a DrawingML text box with its a: namespace bound — never an unbound prefix (#517)', async () => {
    const source = await makeDocx(
      para('Intro paragraph.') +
        floatingAlternateContentTextBoxParagraph('Choice text kept', 'Stale VML fallback text')
    );
    const { tree } = await parse(source, 'source.docx');
    const docXml = await generatedDocumentXml(tree);

    // The re-emitted blob really does carry the a:graphic subtree...
    expect(docXml).toContain('<a:graphic');
    // ...and the a: prefix is bound in scope (inline on the graphic, as Word
    // emits) — never left dangling by docx's a-less generated document root.
    expect(docXml).toMatch(/<a:graphic[^>]*xmlns:a=/);
  });

  // #515/ADR-086: the unit-level suites (body-objects.test.ts,
  // body-text-box-visibility.test.ts) pin no-suppression + privacy at the
  // extractBodyObjects/blob-anchor boundary. This is the one test in the
  // whole #515 program that proves it holds THROUGH the generator: a full
  // parse -> generate -> re-parse cycle on a host paragraph carrying one
  // visible and one hidden text box, checking BOTH the SpecTree-level
  // objectText exposure AND the raw re-emitted OOXML's byte-for-byte content.
  it('a mixed-visibility paragraph (one visible, one hidden text box) round-trips its FULL host blob byte-for-byte, while interiorTexts exposes only the visible box (#515)', async () => {
    const source = await makeDocx(
      para('Intro paragraph.') +
        mixedVisibilityTwoTextBoxParagraph('Visible box text', 'Secret hidden box text')
    );
    const { tree } = await parse(source, 'source.docx');
    const before = objectNodesOf(tree);
    expect(before).toHaveLength(1);
    expectObjectMeta(before[0], { kind: 'textBox', generation: 'drawingml', floating: false });
    // Privacy: the hidden SECOND box's interior text never reaches
    // interiorTexts — the fix suppresses the ANCHOR, not the OOXML content
    // (checked directly against the generated document below).
    expect(objectTextsOf(before[0] as SpecNode)).toEqual(['Visible box text']);

    const docXmlBefore = await generatedDocumentXml(tree);
    // The hidden box's OWN OOXML — including its w:vanish marker — survives
    // untouched in the FIRST generation, proving the blob really does still
    // carry the WHOLE host paragraph (both boxes), not just the visible one.
    expect(docXmlBefore).toContain('Secret hidden box text');
    expect(docXmlBefore).toContain('<w:vanish/>');

    const reparsedTree = await regenerateAndReparse(tree);
    const after = objectNodesOf(reparsedTree);

    expect(after).toHaveLength(1);
    expectObjectMeta(after[0], { kind: 'textBox', generation: 'drawingml', floating: false });
    // No-suppression + privacy hold across a FULL regenerate -> re-parse
    // cycle, not just the first capture.
    expect(objectTextsOf(after[0] as SpecNode)).toEqual(['Visible box text']);

    const docXmlAfter = await generatedDocumentXml(reparsedTree);
    // Byte-identity: the hidden box's interior text and its w:vanish marker
    // are still present verbatim after a SECOND regeneration — the opaque
    // subtree was never reinterpreted, only ever passed through by reference.
    expect(docXmlAfter).toContain('Secret hidden box text');
    expect(docXmlAfter).toContain('<w:vanish/>');
  });
});

// #519 (WS3 task 2/8, this file's own crux acceptance criterion): the DOCX-
// fidelity proof that an edit made via `object-blob-edit.ts`'s
// `replaceAnchoredParagraphText` — the primitive WS3b's DB write path
// (`db/queries/object-text-edit.ts`) will call — actually reaches a
// regenerated document and survives a re-parse. Every test above proves the
// CAPTURE path is round-trip-faithful; these two prove the EDIT path is.
//
// The fixture is deliberately ONE table with TWO cells (never two separate
// table objects): `transformChildren` (body-objects.ts) anchors EVERY
// non-empty interior paragraph independently, so a 2-cell table captures as
// ONE `object` node whose SINGLE blob carries TWO `w:sdt` anchors — the
// multi-anchor-sharing-one-blob shape the spike found necessary. Two
// separate table objects would each get their own wholly independent blob,
// never exercising the rebuild walk's leaf guard the way a real multi-row/
// multi-cell table does (see object-blob-edit.ts's own module comment and
// its "non-anchor siblings are untouched" unit test, which pins the guard in
// isolation; this file pins it through the real capture + generate + parse
// pipeline).
describe('body object round trip — editing an anchored paragraph via replaceAnchoredParagraphText (#519, WS3 task 2/8)', () => {
  it('invariant: round-trip fidelity — an edit applied to one of two anchored paragraphs sharing the same object survives generateDocx + re-parse, without altering its untouched sibling paragraph', async () => {
    const source = await makeDocx(
      para('Intro paragraph.') +
        table(row(cell(para('First cell text')) + cell(para('Second cell text'))))
    );
    const { tree } = await parse(source, 'source.docx');
    const objects = objectNodesOf(tree);
    expect(objects).toHaveLength(1);
    const target = objects[0] as SpecNode;
    const objectTextNodes = target.children.filter((c) => c.type === 'objectText');
    expect(objectTextNodes).toHaveLength(2);
    expect(objectTextNodes.map((n) => n.text)).toEqual(['First cell text', 'Second cell text']);

    const editedTree = withEditedObjectBlob(
      tree,
      target.id,
      objectTextNodes[0]?.id as string,
      'Edited first cell text'
    );
    const reparsedTree = await regenerateAndReparse(editedTree);
    const after = objectNodesOf(reparsedTree);

    expect(after).toHaveLength(1);
    expectObjectMeta(after[0], { kind: 'table' });
    // The edited cell reflects the new text, AND its untouched sibling
    // anchor — sharing the exact same blob array — survives byte-for-byte.
    expect(objectTextsOf(after[0] as SpecNode)).toEqual([
      'Edited first cell text',
      'Second cell text',
    ]);
  });

  it("invariant: interior text reaches the DOCX only through the parent object's blob — a stale objectText.text left untouched in the tree never leaks into the regenerated document", async () => {
    const source = await makeDocx(
      para('Intro paragraph.') +
        table(row(cell(para('First cell text')) + cell(para('Second cell text'))))
    );
    const { tree } = await parse(source, 'source.docx');
    const target = objectNodesOf(tree)[0] as SpecNode;
    const objectTextNodes = target.children.filter((c) => c.type === 'objectText');
    const anchorUuid = objectTextNodes[0]?.id as string;

    // Edit the BLOB only — withEditedObjectBlob never touches objectText.text.
    const editedTree = withEditedObjectBlob(tree, target.id, anchorUuid, 'Blob-only edited text');
    const editedObject = flatten(editedTree.parts).find((n) => n.id === target.id);
    const editedFirstText = editedObject?.children.find((c) => c.id === anchorUuid);
    // The tree's own objectText.text field is deliberately left stale here —
    // proving the field itself carries no generation authority.
    expect(editedFirstText?.text).toBe('First cell text');

    const reparsedTree = await regenerateAndReparse(editedTree);
    const after = objectNodesOf(reparsedTree);

    // The regenerated + re-parsed document reflects the BLOB's text, not the
    // stale objectText.text the tree still carried going into generateDocx —
    // and the untouched sibling anchor is unaffected either way.
    expect(objectTextsOf(after[0] as SpecNode)).toEqual([
      'Blob-only edited text',
      'Second cell text',
    ]);
    expect(objectTextsOf(after[0] as SpecNode)).not.toContain('First cell text');
  });
});

// KNOWN AMBIGUITY: (WS3) only the captured object's KIND/generation/floating
// and its interior TEXT are round-trip invariants. The outer `object` node's
// own uuid, and every interior objectText leaf's uuid, are freshly minted on
// each capture (parser/docx/object-anchor.ts) — SpecR narrows "round trip"
// to text-preservation, never id-identity, across a regenerate+re-parse
// cycle. A future merge-identity requirement (stable ids across
// regeneration) is explicitly out of scope here. Pinned below (not just
// asserted in prose) so a future change to this behavior is a deliberate,
// reviewed decision, not a silent drift.
describe('body object round trip — KNOWN AMBIGUITY (WS3): ids are never round-trip invariants', () => {
  it('mints a fresh uuid for the object node AND every objectText leaf on every regenerate+re-parse cycle', async () => {
    const source = await makeDocx(
      para('Intro paragraph.') + table(row(cell(para('Round-trip table cell text'))))
    );
    const { tree } = await parse(source, 'source.docx');
    const beforeObject = objectNodesOf(tree)[0] as SpecNode;
    const beforeObjectTextId = beforeObject.children.find((c) => c.type === 'objectText')?.id;
    expect(beforeObjectTextId).toBeDefined();

    const reparsedTree = await regenerateAndReparse(tree);
    const afterObject = objectNodesOf(reparsedTree)[0] as SpecNode;
    const afterObjectTextId = afterObject.children.find((c) => c.type === 'objectText')?.id;

    expect(afterObject.id).not.toBe(beforeObject.id);
    expect(afterObjectTextId).toBeDefined();
    expect(afterObjectTextId).not.toBe(beforeObjectTextId);
  });
});
