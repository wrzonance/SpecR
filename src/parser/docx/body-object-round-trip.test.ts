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
import { parse } from '../index.js';
import { generateDocx } from '../../generator/index.js';
import type { SpecNode, SpecTree } from '../../ast/types.js';

// Namespaces docx@9.7.1 itself declares on its generated <w:document> root
// (verified against the installed dependency) — the hand-authored source
// fixtures below need the same set so a real mc:AlternateContent/w:pict text
// box parses exactly like a real Word-authored document would.
const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
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
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
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
});

// KNOWN AMBIGUITY (WS3): only the captured object's KIND/generation/floating
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
