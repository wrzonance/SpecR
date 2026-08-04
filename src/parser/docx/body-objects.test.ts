import { describe, it, expect } from 'vitest';
import { extractBodyObjects, anchorInteriorParagraphs } from './body-objects.js';
import { computeBodyOrder } from './body-order.js';
import { createDocumentXmlParser, createOrderedDocumentXmlBuilder, toArray } from './xml-utils.js';
import { buildStyleMap } from './styles.js';
import { UUID_TAG_PREFIX } from '../../ast/index.js';
import type { StyleMap } from './types.js';
import type { BodyObjectExtractionResult } from './body-objects.js';
import type { ObjectBlobNode } from '../../ast/index.js';

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"',
  'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"',
].join(' ');

const EMPTY_STYLES = buildStyleMap(
  `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
);

function makeDocXml(bodyXml: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}>` +
    `<w:body>${bodyXml}</w:body></w:document>`
  );
}

function para(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function vanishPara(text: string): string {
  return `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
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

function tableWithGrid(gridColCount: number, rowsXml: string): string {
  const grid = `<w:tblGrid>${'<w:gridCol/>'.repeat(gridColCount)}</w:tblGrid>`;
  return `<w:tbl>${grid}${rowsXml}</w:tbl>`;
}

// One drawingml text box run, inline (non-floating), whose txbxContent holds
// exactly one interior paragraph carrying `interiorText`.
function textBoxParagraph(interiorText: string): string {
  return (
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    para(interiorText) +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r></w:p>'
  );
}

// An out-of-scope chart drawable (dropped, never captured as an object).
function chartParagraph(): string {
  return (
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart r:id="rId9"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

// An out-of-scope smartArt (diagram) drawable — a second, DISTINCT dropped
// kind, so the no-silent-loss test can prove more than one drop survives.
function smartArtParagraph(): string {
  return (
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
    '<dgm:relIds r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r></w:p>'
  );
}

// A text box wrapped in mc:AlternateContent (#517): mc:Choice carries the
// DrawingML text box with `interiorText`, mc:Fallback carries an equivalent
// VML text box with a DIFFERENT ("stale") interior text — the realistic
// shape Word emits for a modern text box (mirrors alternate-content.test.ts's
// own ALTERNATE_CONTENT_RUN_XML fixture). Before the #517 fix,
// anchorInteriorParagraphs's depth-agnostic w:p walk found w:p descendants
// in BOTH the Choice and the stale Fallback branch, doubling interiorTexts.
function alternateContentTextBoxParagraph(interiorText: string, fallbackText: string): string {
  return (
    '<w:p><w:r><mc:AlternateContent>' +
    '<mc:Choice Requires="wps">' +
    '<w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    para(interiorText) +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing>' +
    '</mc:Choice>' +
    '<mc:Fallback>' +
    '<w:pict><v:shape><v:textbox><w:txbxContent>' +
    para(fallbackText) +
    '</w:txbxContent></v:textbox></v:shape></w:pict>' +
    '</mc:Fallback>' +
    '</mc:AlternateContent></w:r></w:p>'
  );
}

// A single w:r run's own <w:drawing> content, WITHOUT the enclosing <w:p><w:r>
// wrapper — a building block for a two-run paragraph (see twoDrawingRuns).
function chartRun(): string {
  return (
    '<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart r:id="rId9"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  );
}

function smartArtRun(): string {
  return (
    '<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
    '<dgm:relIds r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r>'
  );
}

function textBoxRun(interiorText: string): string {
  return (
    '<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    para(interiorText) +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r>'
  );
}

// One host paragraph, TWO SEPARATE drawing-bearing runs: `firstRun`'s
// classification used to decide the WHOLE paragraph's fate (#300 review) —
// this builder proves every run is now classified independently.
function twoDrawingRunsParagraph(firstRun: string, secondRun: string): string {
  return `<w:p>${firstRun}${secondRun}</w:p>`;
}

// A vanish (hidden) text box RUN: the txbxContent's own interior run carries
// w:rPr>w:vanish, mirroring vanishPara's convention above but nested inside
// the drawing rather than a plain body paragraph. Run-level (no host <w:p>
// wrapper) so it can compose with other drawing runs via twoDrawingRunsParagraph.
function hiddenTextBoxRun(interiorText: string): string {
  const hiddenInterior = `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${interiorText}</w:t></w:r></w:p>`;
  return (
    '<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    hiddenInterior +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r>'
  );
}
function hiddenTextBoxParagraph(interiorText: string): string {
  return `<w:p>${hiddenTextBoxRun(interiorText)}</w:p>`;
}

// A hidden, FLOATING, VML text box RUN — deliberately the opposite
// generation ('vml' vs textBoxRun's 'drawingml') AND the opposite floating
// value (position:absolute vs textBoxRun's inline) from `textBoxRun`, so a
// test pairing the two can tell whether captured object metadata came from
// THIS entry or the other one. Hidden via the interior run's own
// `w:rPr>w:vanish`, mirroring hiddenTextBoxRun's convention.
function hiddenFloatingVmlTextBoxRun(interiorText: string): string {
  const hiddenInterior = `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>${interiorText}</w:t></w:r></w:p>`;
  return (
    '<w:r><w:pict><v:shape style="position:absolute"><v:textbox><w:txbxContent>' +
    hiddenInterior +
    '</w:txbxContent></v:textbox></v:shape></w:pict></w:r>'
  );
}

// A text box hidden via its HOST paragraph mark (w:pPr>w:rPr>w:vanish) rather
// than the interior run — the other of the two mechanisms the review finding
// named.
function hostMarkHiddenTextBoxParagraph(interiorText: string): string {
  return (
    '<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr>' +
    '<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    para(interiorText) +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r></w:p>'
  );
}

// #641 fixture builders: like textBoxParagraph/hostMarkHiddenTextBoxParagraph
// above, but take arbitrary interior XML rather than a single plain-text
// paragraph, so a text box's OWN interior paragraph can itself carry a
// NESTED drawing run (a text box inside a text box).
function textBoxHostParagraph(interiorXml: string): string {
  return (
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    interiorXml +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r></w:p>'
  );
}

function hostMarkHiddenTextBoxHostParagraph(interiorXml: string): string {
  return (
    '<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr>' +
    '<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:txbx><w:txbxContent>' +
    interiorXml +
    '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r></w:p>'
  );
}

// Mirrors document.ts's own createDocumentXmlParser(['w:p','w:r','w:hyperlink'])
// config, so this test feeds extractBodyObjects the SAME shape of rawParagraphs
// index.ts (a later task) will thread in from document.ts's own parse.
const rawParagraphParser = createDocumentXmlParser(['w:p', 'w:r', 'w:hyperlink']);

function rawParagraphsOf(documentXml: string): readonly Record<string, unknown>[] {
  const parsed = rawParagraphParser.parse(documentXml) as Record<string, unknown>;
  const doc = parsed['w:document'] as Record<string, unknown> | undefined;
  const body = doc?.['w:body'] as Record<string, unknown> | undefined;
  return toArray<Record<string, unknown>>(
    body?.['w:p'] as readonly Record<string, unknown>[] | undefined
  );
}

function extract(bodyXml: string, styleMap: StyleMap = EMPTY_STYLES): BodyObjectExtractionResult {
  const xml = makeDocXml(bodyXml);
  return extractBodyObjects(computeBodyOrder(xml), rawParagraphsOf(xml), styleMap);
}

function tagValues(blob: readonly unknown[]): readonly string[] {
  const xml = createOrderedDocumentXmlBuilder().build(blob);
  return [...xml.matchAll(/<w:tag w:val="([^"]*)"/g)].map((m) => m[1] ?? '');
}

// The interiorTexts <-> blob-anchor 1:1 invariant, asserted on the anchor
// VALUES rather than only their count (#515 adversarial review): equal counts
// alone would still pass if the sole surviving anchor carried a uuid that
// belongs to no interiorTexts entry — a dangling anchor beside an unanchored
// leaf. Comparing the exact `w:tag w:val` set against
// `UUID_TAG_PREFIX + id`, in blob document order, closes that gap.
function expectAnchorsMatchInteriorTexts(
  object: BodyObjectExtractionResult['paragraphObjects'][number]['object'] | undefined
): void {
  expect(tagValues(object?.blob ?? [])).toEqual(
    (object?.interiorTexts ?? []).map(({ id }) => `${UUID_TAG_PREFIX}${id}`)
  );
}

// Hand-built ObjectBlobNode fixtures (preserveOrder-mode shape) for
// anchorInteriorParagraphs's own unit tests below — mirrors
// body-text-box-visibility.test.ts's own fixture style rather than reusing
// the XML-string builders above (`para`, `textBoxParagraph`, …), which build
// a DIFFERENT shape (raw XML strings, not ObjectBlobNode trees).
function blobTextNode(text: string): ObjectBlobNode {
  return { '#text': text };
}

function blobPara(text: string): ObjectBlobNode {
  return { 'w:p': [{ 'w:r': [{ 'w:t': [blobTextNode(text)] }] }] };
}

function blobTxbxContent(text: string): ObjectBlobNode {
  return { 'w:txbxContent': [blobPara(text)] };
}

// A drawing run wrapping one txbxContent boundary, nested several levels deep
// (w:r > w:drawing > a:graphic > a:graphicData > wps:txbx > w:txbxContent) —
// the same nesting shape body-text-box-visibility.test.ts's drawingRun uses.
function blobDrawingRun(content: ObjectBlobNode): ObjectBlobNode {
  return {
    'w:r': [{ 'w:drawing': [{ 'a:graphic': [{ 'a:graphicData': [{ 'wps:txbx': [content] }] }] }] }],
  };
}

function blobHostParagraph(children: readonly ObjectBlobNode[]): ObjectBlobNode {
  return { 'w:p': children };
}

// Depth-first search for the first `w:txbxContent`-tagged descendant of
// `node` (including `node` itself) — a local test-only helper, not a
// duplicate of body-objects.ts's own collection logic (this one is used only
// to LOCATE the boundary in the returned tree for a reference-identity check).
function findTxbxContentNode(node: ObjectBlobNode): ObjectBlobNode | undefined {
  const tag = Object.keys(node).find((key) => key !== ':@');
  if (tag === 'w:txbxContent') return node;
  const value = tag ? node[tag] : undefined;
  if (!Array.isArray(value)) return undefined;
  for (const child of value as readonly ObjectBlobNode[]) {
    const found = findTxbxContentNode(child);
    if (found) return found;
  }
  return undefined;
}

// #641: depth-first collection of EVERY `w:txbxContent`-tagged descendant of
// `node`, in document order — UNLIKE findTxbxContentNode above (and unlike
// body-text-box-visibility.ts's own production collectTxbxContentNodes),
// this one keeps recursing INTO a found boundary's own children, so a
// text-box-inside-a-text-box fixture yields BOTH the outer and the nested
// boundary (outer first). Test-only: used to locate the SAME nested
// w:txbxContent node in two independently-built trees for the byte-identity
// round-trip assertion below.
function collectAllTxbxContentNodes(node: ObjectBlobNode): ObjectBlobNode[] {
  const tag = Object.keys(node).find((key) => key !== ':@');
  const found: ObjectBlobNode[] = tag === 'w:txbxContent' ? [node] : [];
  const value = tag ? node[tag] : undefined;
  if (!Array.isArray(value)) return found;
  for (const child of value as readonly ObjectBlobNode[]) {
    found.push(...collectAllTxbxContentNodes(child));
  }
  return found;
}

describe('anchorInteriorParagraphs — hiddenSubtrees pass-through (#515 task 3)', () => {
  it('backward compatibility: default (no hiddenSubtrees) anchors an interior paragraph exactly as before', () => {
    const inner = blobTxbxContent('interior text');
    const host = blobHostParagraph([blobDrawingRun(inner)]);

    const result = anchorInteriorParagraphs(host);

    expect(result.interiorTexts.map((t) => t.text)).toEqual(['interior text']);
    // The w:txbxContent boundary itself gets REBUILT (its interior w:p is
    // anchored), so it must NOT be the same reference as the original —
    // proves this test's control case actually exercises the anchor path.
    expect(findTxbxContentNode(result.node)).not.toBe(inner);
  });

  it('round-trip byte-identity: a hiddenSubtrees-matched w:txbxContent node passes through UNCHANGED (same reference), contributing no interiorTexts', () => {
    const inner = blobTxbxContent('secret interior text');
    const host = blobHostParagraph([blobDrawingRun(inner)]);

    const result = anchorInteriorParagraphs(host, new Set([inner]));

    expect(result.interiorTexts).toEqual([]);
    // Same object reference, never rebuilt or recursed into — the exact
    // invariant buildTextBoxObject's future wiring (a later task) depends on
    // for provable serialization equivalence.
    expect(findTxbxContentNode(result.node)).toBe(inner);
  });

  it('backward compatibility: buildTableObject-style caller (single-argument call) still type-checks and anchors normally', () => {
    // Mirrors buildTableObject's own zero-edit call site:
    // `anchorInteriorParagraphs(normalized)`, no second argument.
    const host = blobHostParagraph([blobPara('table cell text')]);
    const result = anchorInteriorParagraphs(host);
    expect(result.interiorTexts.map((t) => t.text)).toEqual(['table cell text']);
  });
});

describe('extractBodyObjects — no-silent-loss across tables, text boxes, and dropped drawables', () => {
  it('captures a table and a text box, and drops a chart, all from one document — nothing lost', () => {
    const body =
      para('intro') +
      table(row(cell(para('cell one')))) +
      textBoxParagraph('box text') +
      chartParagraph() +
      para('outro');
    const result = extract(body);

    expect(result.tableObjects).toHaveLength(1);
    expect(result.tableObjects[0]?.precedingParagraphIndex).toBe(0); // after 'intro'
    expect(result.tableObjects[0]?.object.kind).toBe('table');
    expect(result.tableObjects[0]?.object.interiorTexts.map((t) => t.text)).toEqual(['cell one']);

    expect(result.paragraphObjects).toHaveLength(1);
    expect(result.paragraphObjects[0]?.paragraphIndex).toBe(1); // the text box paragraph
    expect(result.paragraphObjects[0]?.object.kind).toBe('textBox');
    expect(result.paragraphObjects[0]?.object.interiorTexts.map((t) => t.text)).toEqual([
      'box text',
    ]);

    expect(result.dropped).toEqual([{ kind: 'chart' }]);
  });

  it('collects every dropped drawable across multiple paragraphs, never silently losing one', () => {
    const body = chartParagraph() + para('plain') + smartArtParagraph();
    const result = extract(body);
    expect(result.dropped).toEqual([{ kind: 'chart' }, { kind: 'smartArt' }]);
    expect(result.paragraphObjects).toEqual([]);
    expect(result.tableObjects).toEqual([]);
  });

  it('skips a hidden (all-vanish) table entirely — no object AND no dropped entry (ADR-038 path untouched)', () => {
    const body = table(row(cell(vanishPara('secret'))));
    const result = extract(body);
    expect(result.tableObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('interior paragraphs carry a w:sdt round-trip anchor whose uuid matches interiorTexts', () => {
    const body = table(row(cell(para('anchored'))));
    const result = extract(body);
    const object = result.tableObjects[0]?.object;
    const id = object?.interiorTexts[0]?.id;
    expect(id).toBeDefined();
    expect(tagValues(object?.blob ?? [])).toEqual([`${UUID_TAG_PREFIX}${id}`]);
  });
});

describe('extractBodyObjects — multiple drawing runs in one paragraph (#300 review)', () => {
  it('captures a text box even when a NON-textBox drawing (chart) precedes it in the same paragraph', () => {
    const body = twoDrawingRunsParagraph(chartRun(), textBoxRun('box text 2'));
    const result = extract(body);
    expect(result.paragraphObjects).toHaveLength(1);
    expect(result.paragraphObjects[0]?.object.kind).toBe('textBox');
    expect(result.paragraphObjects[0]?.object.interiorTexts.map((t) => t.text)).toEqual([
      'box text 2',
    ]);
    // The chart round-trips verbatim inside the captured host-paragraph blob
    // (decision 1) — it is part of the object now, never a separate drop.
    expect(result.dropped).toEqual([]);
  });

  it('collects EACH non-textBox drawing in one paragraph as its own dropped entry, not just the first', () => {
    const body = twoDrawingRunsParagraph(chartRun(), smartArtRun());
    const result = extract(body);
    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([{ kind: 'chart' }, { kind: 'smartArt' }]);
  });
});

describe('extractBodyObjects — hidden (vanish) text boxes (ADR-038 parity)', () => {
  it('skips a text box hidden via its interior run (w:rPr>w:vanish) entirely — no object AND no dropped entry', () => {
    const body = hiddenTextBoxParagraph('secret box text');
    const result = extract(body);
    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('skips a text box hidden via its HOST paragraph mark (w:pPr>w:rPr>w:vanish) entirely', () => {
    const body = hostMarkHiddenTextBoxParagraph('secret box text');
    const result = extract(body);
    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('reports a co-occurring chart as dropped when only the text box is hidden (interior vanish) and the host paragraph is visible', () => {
    // Hidden box → no object captures the host blob, so the chart is preserved
    // nowhere; it must still surface as a dropped drawable (ADR-072 decision 9).
    const body = twoDrawingRunsParagraph(chartRun(), hiddenTextBoxRun('secret box'));
    const result = extract(body);
    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([{ kind: 'chart' }]);
  });

  it('drops nothing when the whole host paragraph is vanish — a co-occurring chart is intentionally hidden too', () => {
    const body = `<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr>${chartRun()}${textBoxRun('box')}</w:p>`;
    const result = extract(body);
    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('still captures a VISIBLE text box sitting alongside a hidden one — the hidden split is per-paragraph', () => {
    const body = hiddenTextBoxParagraph('hidden') + textBoxParagraph('visible');
    const result = extract(body);
    expect(result.paragraphObjects).toHaveLength(1);
    expect(result.paragraphObjects[0]?.object.interiorTexts.map((t) => t.text)).toEqual([
      'visible',
    ]);
  });
});

describe('extractBodyObjects — buildTextBoxObject hiddenFlags wiring (#515 task 4)', () => {
  // Regression pin: resolveHiddenTxbxContentNodes (#515 task 1) fails closed
  // on any boundary-count/flag-count mismatch — a host paragraph with one
  // text box has exactly one w:txbxContent boundary, so a naive `[]` (0
  // entries) mismatches 1 vs. 0 and wrongly suppresses it entirely. The
  // wiring must correlate a count-correct flag for the single already-known-
  // visible entry instead.
  it('backward compatibility: a single visible text box still surfaces interiorTexts (not fail-closed suppressed by a naive empty flags array)', () => {
    const body = textBoxParagraph('visible box text');
    const result = extract(body);
    expect(result.paragraphObjects).toHaveLength(1);
    expect(result.paragraphObjects[0]?.object.interiorTexts.map((t) => t.text)).toEqual([
      'visible box text',
    ]);
  });

  it('interiorTexts 1:1 anchors: the visible text box interior paragraph carries a w:sdt round-trip anchor whose uuid matches interiorTexts', () => {
    const body = textBoxParagraph('anchored box text');
    const result = extract(body);
    const object = result.paragraphObjects[0]?.object;
    const id = object?.interiorTexts[0]?.id;
    expect(id).toBeDefined();
    expect(tagValues(object?.blob ?? [])).toEqual([`${UUID_TAG_PREFIX}${id}`]);
  });

  it('round-trip byte-identity: the wiring does not change hidden (all-vanish) text box handling — still no object, no dropped entry', () => {
    const body = hiddenTextBoxParagraph('secret box text');
    const result = extract(body);
    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});

describe('extractBodyObjects — mixed visible/hidden text boxes in one host paragraph (#515 task 5)', () => {
  // Privacy (no-leak): before this fix, collectParagraphDrawing decided
  // visibility from the FIRST text-box entry alone while buildTextBoxObject's
  // anchor walk surfaced objectText from EVERY text box in the host blob — so
  // a hidden SECOND box's interior text leaked into interiorTexts alongside
  // the visible first box's text.
  it('privacy: a hidden SECOND text box never leaks its interior text when a visible first box is captured', () => {
    const body = twoDrawingRunsParagraph(
      textBoxRun('visible text'),
      hiddenTextBoxRun('secret text')
    );
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['visible text']);
    expect(object?.interiorTexts.map((t) => t.text)).not.toContain('secret text');
  });

  // No-suppression (no-loss): before this fix, a hidden FIRST box alone
  // decided the whole paragraph's fate, so a visible SECOND box's text was
  // entirely lost (treated as if the whole paragraph were hidden).
  it('no-suppression: a visible SECOND text box still surfaces its text when the FIRST box is hidden', () => {
    const body = twoDrawingRunsParagraph(
      hiddenTextBoxRun('secret text'),
      textBoxRun('visible text')
    );
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['visible text']);
  });

  // All-hidden preserved: when EVERY text box in the host paragraph is
  // hidden, the paragraph produces no object and no dropped entry — same
  // outcome as the single-box all-hidden case, now correctly decided over
  // every box rather than just the first.
  it('all-hidden preserved: two hidden text boxes in one host paragraph produce no object and no dropped entry', () => {
    const body = twoDrawingRunsParagraph(
      hiddenTextBoxRun('secret one'),
      hiddenTextBoxRun('secret two')
    );
    const result = extract(body);

    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});

describe('extractBodyObjects — mixed-visibility text boxes in ONE host paragraph (#515)', () => {
  // two-visible: both text boxes in the host paragraph are visible — every
  // interior paragraph gets its own w:sdt anchor, and interiorTexts stays
  // 1:1 with the anchors actually baked into the blob (no box's text is
  // dropped just because it shares a host paragraph with another box).
  it('two-visible: both text boxes surface their interior text, 1:1 with the anchors baked into blob', () => {
    const body = twoDrawingRunsParagraph(textBoxRun('first text'), textBoxRun('second text'));
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['first text', 'second text']);
    expect(result.dropped).toEqual([]);
    expectAnchorsMatchInteriorTexts(object);
    expect(tagValues(object?.blob ?? [])).toHaveLength(2);
  });

  // visible+hidden: the FIRST box is visible, the SECOND is hidden. Privacy
  // (no-leak): the hidden box's interior text never reaches interiorTexts.
  // The tagValues(blob) count is the independent, blob-level check that the
  // hidden box's w:txbxContent boundary was left un-anchored (opaque
  // pass-through) rather than merely filtered out of interiorTexts while
  // still secretly anchored in the blob.
  it('visible+hidden: interiorTexts.length matches the anchors baked into blob — the hidden second box leaks nothing', () => {
    const body = twoDrawingRunsParagraph(
      textBoxRun('visible first'),
      hiddenTextBoxRun('hidden second')
    );
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['visible first']);
    expect(object?.interiorTexts.map((t) => t.text)).not.toContain('hidden second');
    expectAnchorsMatchInteriorTexts(object);
    expect(tagValues(object?.blob ?? [])).toHaveLength(1);
  });

  // hidden+visible: the FIRST box is hidden, the SECOND is visible.
  // No-suppression (no-loss): the visible second box's text is not dropped
  // just because the first box in the same host paragraph is hidden. Same
  // blob-level tagValues check as above, mirrored for the opposite order.
  it('hidden+visible: interiorTexts.length matches the anchors baked into blob — the visible second box is never suppressed', () => {
    const body = twoDrawingRunsParagraph(
      hiddenTextBoxRun('hidden first'),
      textBoxRun('visible second')
    );
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['visible second']);
    expectAnchorsMatchInteriorTexts(object);
    expect(tagValues(object?.blob ?? [])).toHaveLength(1);
  });

  // two-hidden: both text boxes in the host paragraph are hidden — the whole
  // paragraph produces no object (nothing visible to capture) and no dropped
  // entry (both boxes are intentionally hidden, not lost).
  it('two-hidden: two hidden text boxes in one host paragraph produce no object and no dropped entry', () => {
    const body = twoDrawingRunsParagraph(
      hiddenTextBoxRun('hidden first'),
      hiddenTextBoxRun('hidden second')
    );
    const result = extract(body);

    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});

describe('extractBodyObjects — shared object metadata sources from the first VISIBLE entry (ADR-087 decision 5)', () => {
  // Review finding (#515): every mixed-visibility fixture elsewhere in this
  // suite pairs two structurally-identical, non-floating textBoxRun/
  // hiddenTextBoxRun entries, so `chosen.classification` (kind/floating/
  // generation) is indistinguishable from `textBoxEntries[0]`'s in every one
  // of those assertions — none of them would fail if buildTextBoxObject
  // regressed to picking the first entry regardless of visibility (the exact
  // pre-#515 bug ADR-087 decision 5 documents). This pairs a HIDDEN,
  // FLOATING, VML box first with a VISIBLE, non-floating, DrawingML box
  // second: `textBoxEntries[0]` and the correct VISIBLE choice disagree on
  // BOTH `generation` and `floating`, so a regression to first-entry-
  // regardless-of-visibility flips both fields and fails this test.
  it("a hidden floating VML box first + a visible inline DrawingML box second reports the VISIBLE box's generation/floating, not the first entry's", () => {
    const body = twoDrawingRunsParagraph(
      hiddenFloatingVmlTextBoxRun('hidden vml text'),
      textBoxRun('visible drawingml text')
    );
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['visible drawingml text']);
    expect(object?.generation).toBe('drawingml');
    expect(object?.floating).toBe(false);
  });
});

describe('extractBodyObjects — text box wrapped in a differently-tagged sibling (#515 review CRITICAL)', () => {
  // classifyParagraphDrawings walks raw's GROUPED-mode tree, which only
  // preserves relative order among SAME-tag siblings (header-footer-run-
  // order.ts's own documented limitation) — a text-box run wrapped in
  // w:hyperlink (a realistic shape: a hyperlinked, or tracked-change-
  // inserted, text box) used to get pushed to the END of the traversal
  // regardless of where it actually sits, desyncing hiddenFlags from
  // resolveHiddenTxbxContentNodes' TRUE-document-order w:txbxContent
  // boundaries — leaking the hidden box's text and suppressing the visible
  // box that came after it.
  it('correlates hiddenFlags by TRUE document order even when the hidden box sits inside a w:hyperlink between two plain-run boxes', () => {
    const body =
      `<w:p>${textBoxRun('first text')}` +
      `<w:hyperlink>${hiddenTextBoxRun('secret text')}</w:hyperlink>` +
      `${textBoxRun('third text')}</w:p>`;
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['first text', 'third text']);
    expect(object?.interiorTexts.map((t) => t.text)).not.toContain('secret text');
    expectAnchorsMatchInteriorTexts(object);
    expect(tagValues(object?.blob ?? [])).toHaveLength(2);
  });
});

describe('extractBodyObjects — BLOCK-level mc:AlternateContent (#515 adversarial review)', () => {
  // Regression pin for a data-loss bug the #515 fix itself introduced and
  // this test now closes. Hidden flags come from the UN-normalized grouped
  // `raw` tree; w:txbxContent boundaries come from the blob AFTER
  // stripAlternateContentFallback has spliced out every mc:Fallback. When
  // mc:AlternateContent sits at BLOCK level — wrapping whole `w:r` elements
  // per branch rather than the run-level shape Word usually emits — the
  // Fallback's own text-box run was classified too, producing 2 flags
  // against 1 surviving boundary. resolveHiddenTxbxContentNodes' count guard
  // then failed closed and suppressed the VISIBLE mc:Choice box's interior
  // text entirely (verified: 'Choice visible text' on origin/main, [] on the
  // pre-fix branch). collectFallbackRuns excludes Fallback runs from
  // classification, restoring the count correspondence.
  it('a block-level mc:AlternateContent still surfaces the visible mc:Choice box text — the discarded mc:Fallback run never miscounts the flags', () => {
    const body =
      '<w:p><mc:AlternateContent>' +
      `<mc:Choice Requires="wps">${textBoxRun('choice visible text')}</mc:Choice>` +
      '<mc:Fallback><w:r><w:pict><v:shape><v:textbox><w:txbxContent>' +
      para('fallback text') +
      '</w:txbxContent></v:textbox></v:shape></w:pict></w:r></mc:Fallback>' +
      '</mc:AlternateContent></w:p>';
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['choice visible text']);
    // The discarded Fallback branch contributes neither interior text nor a
    // dropped entry — it is an alternate rendering of the SAME content, never
    // additional content that could be silently lost.
    expect(object?.interiorTexts.map((t) => t.text)).not.toContain('fallback text');
    expect(result.dropped).toEqual([]);
    expectAnchorsMatchInteriorTexts(object);
  });

  // The run-level shape (w:r > mc:AlternateContent > mc:Choice > w:drawing)
  // puts no w:r inside the Fallback at all, so it was never affected — pinned
  // here alongside the block-level case so a future change to
  // collectFallbackRuns cannot regress either shape unnoticed.
  it('the run-level mc:AlternateContent shape Word normally emits is unaffected', () => {
    const result = extract(alternateContentTextBoxParagraph('choice text', 'fallback text'));

    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['choice text']);
    expectAnchorsMatchInteriorTexts(object);
  });

  // Privacy still holds at block level: a hidden mc:Choice box leaks nothing,
  // and its Fallback twin does not accidentally resurrect the content.
  it('a hidden block-level mc:Choice text box captures no object and leaks no interior text', () => {
    const body =
      '<w:p><mc:AlternateContent>' +
      `<mc:Choice Requires="wps">${hiddenTextBoxRun('choice secret text')}</mc:Choice>` +
      '<mc:Fallback><w:r><w:pict><v:shape><v:textbox><w:txbxContent>' +
      para('fallback text') +
      '</w:txbxContent></v:textbox></v:shape></w:pict></w:r></mc:Fallback>' +
      '</mc:AlternateContent></w:p>';
    const result = extract(body);

    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});

describe('extractBodyObjects — tier-classification exclusion', () => {
  it('captures a cell paragraph that looks like a numbered tier ("1. Foo") as verbatim interior text, never a tier node', () => {
    const body = table(row(cell(para('1. Foo'))));
    const result = extract(body);
    const interiorText = result.tableObjects[0]?.object.interiorTexts[0];
    expect(interiorText?.text).toBe('1. Foo');
    // CapturedObjectText is structurally {id, text} only — no nodeType/ilvl/
    // signal field exists for a tier classifier to have written into.
    expect(Object.keys(interiorText ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'id',
      'text',
    ]);
  });

  it('captures a cell paragraph that looks like "PART 2" verbatim, never promoted to a part node', () => {
    const body = table(row(cell(para('PART 2 - PRODUCTS'))));
    const result = extract(body);
    expect(result.tableObjects[0]?.object.interiorTexts[0]?.text).toBe('PART 2 - PRODUCTS');
  });
});

describe('extractBodyObjects — objectText non-emptiness', () => {
  it('excludes an empty interior cell paragraph from interiorTexts, keeping only non-empty ones', () => {
    const body = table(row(cell(para('') + para('kept'))));
    const result = extract(body);
    const interiorTexts = result.tableObjects[0]?.object.interiorTexts ?? [];
    expect(interiorTexts).toHaveLength(1);
    expect(interiorTexts[0]?.text).toBe('kept');
  });

  it('never produces a CapturedObjectText for an all-empty table (interiorTexts stays empty)', () => {
    const body = table(row(cell(para(''))));
    const result = extract(body);
    expect(result.tableObjects[0]?.object.interiorTexts).toEqual([]);
  });

  it('excludes an empty interior paragraph inside a text box, keeping only its non-empty sibling', () => {
    const body =
      '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp><wps:txbx><w:txbxContent>' +
      para('') +
      para('kept box text') +
      '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p>';
    const result = extract(body);
    const interiorTexts = result.paragraphObjects[0]?.object.interiorTexts ?? [];
    expect(interiorTexts).toHaveLength(1);
    expect(interiorTexts[0]?.text).toBe('kept box text');
  });
});

describe('extractBodyObjects — #517 mc:AlternateContent normalization in the capture path', () => {
  it('captures a single objectText leaf from an mc:AlternateContent text box (was doubled)', () => {
    const body = alternateContentTextBoxParagraph('Choice text', 'Fallback text');
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts).toHaveLength(1);
    expect(object?.interiorTexts[0]?.text).toBe('Choice text');
  });

  it('never leaves mc:Fallback or mc:AlternateContent reachable anywhere in the captured blob', () => {
    const body = alternateContentTextBoxParagraph('Choice text', 'Fallback text');
    const result = extract(body);
    const blob = result.paragraphObjects[0]?.object.blob ?? [];
    const xml = createOrderedDocumentXmlBuilder().build(blob);

    expect(xml).not.toContain('mc:Fallback');
    expect(xml).not.toContain('mc:AlternateContent');
    expect(xml).toContain('Choice text');
    expect(xml).not.toContain('Fallback text');
  });
});

describe('extractBodyObjects — #517 mc:AlternateContent normalization in table captures', () => {
  it('captures a single interior text from a table cell embedding an mc:AlternateContent-wrapped drawing (was doubled)', () => {
    const body = table(
      row(cell(alternateContentTextBoxParagraph('Choice cell text', 'Fallback cell text')))
    );
    const result = extract(body);

    expect(result.tableObjects).toHaveLength(1);
    const object = result.tableObjects[0]?.object;
    expect(object?.interiorTexts).toHaveLength(1);
    expect(object?.interiorTexts[0]?.text).toBe('Choice cell text');
  });

  it('never leaves mc:Fallback or mc:AlternateContent reachable anywhere in a captured table blob', () => {
    const body = table(
      row(cell(alternateContentTextBoxParagraph('Choice cell text', 'Fallback cell text')))
    );
    const result = extract(body);
    const blob = result.tableObjects[0]?.object.blob ?? [];
    const xml = createOrderedDocumentXmlBuilder().build(blob);

    expect(xml).not.toContain('mc:Fallback');
    expect(xml).not.toContain('mc:AlternateContent');
    expect(xml).toContain('Choice cell text');
    expect(xml).not.toContain('Fallback cell text');
  });
});

describe('extractBodyObjects — KNOWN AMBIGUITY: nested table/text box inside a captured object (ADR-072 addendum 20)', () => {
  // KNOWN AMBIGUITY: a nested table/text box inside a captured object is
  // flattened into the OUTER object's interiorTexts and never independently
  // promoted to its own `object` node — how to address the inner unit is
  // deferred to WS3.
  // transformChildren/transformInteriorParagraphs (body-objects.ts) recurse
  // into every non-w:p child unconditionally — including a SECOND w:tbl
  // nested inside the outer table's own cell. That nested table's interior
  // paragraph gets the identical w:sdt anchor treatment as the outer table's
  // own direct cell paragraphs, and its text is flattened into the SAME
  // interiorTexts array — with no independent id, editability, or way to
  // address "the nested table" as its own unit. Only ONE `object` (the
  // outer table) ever surfaces; the nested w:tbl is never independently
  // promoted (deferred to WS3). This test PINS today's flattening behavior
  // so a change to it is a deliberate, reviewed decision, not a silent drift.
  it("KNOWN AMBIGUITY: flattens a nested table's interior text into the OUTER object's interiorTexts — the nested table is never independently addressable", () => {
    const body = table(
      row(cell(para('outer cell text') + table(row(cell(para('nested cell text'))))))
    );
    const result = extract(body);

    expect(result.tableObjects).toHaveLength(1);
    const object = result.tableObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual([
      'outer cell text',
      'nested cell text',
    ]);
    // Both paragraphs get a w:sdt anchor from the SAME captured blob — one
    // flat id space, no marker distinguishing the nested table's anchors
    // from the outer table's own.
    expect(tagValues(object?.blob ?? [])).toHaveLength(2);
  });
});

describe('extractBodyObjects — table dimensions', () => {
  it('derives columns from w:tblGrid/w:gridCol when present', () => {
    const body = tableWithGrid(2, row(cell(para('a')) + cell(para('b'))));
    const result = extract(body);
    expect(result.tableObjects[0]?.object.columns).toBe(2);
    expect(result.tableObjects[0]?.object.rows).toBe(1);
  });

  it('falls back to the max per-row cell count when there is no w:tblGrid', () => {
    const body = table(
      row(cell(para('a')) + cell(para('b')) + cell(para('c'))) + row(cell(para('d')))
    );
    const result = extract(body);
    expect(result.tableObjects[0]?.object.columns).toBe(3);
    expect(result.tableObjects[0]?.object.rows).toBe(2);
  });
});

describe('extractBodyObjects — #641 nested text box inside a text box (run-vanish text walk)', () => {
  // The main #641 repro: one host paragraph carries a VISIBLE outer text box.
  // That box's own interior paragraph mixes a visible run ('Outer visible')
  // with a SECOND run holding a NESTED drawing whose own w:txbxContent
  // interior paragraph carries a w:vanish run ('NESTED SECRET'). Before the
  // fix, extractBlobText walked every w:t descendant of the outer interior
  // paragraph regardless of depth or vanish, concatenating the nested
  // secret into the SAME CapturedObjectText as the outer's own visible text
  // (verified against unmodified body-objects.ts: interiorTexts === [{ text:
  // 'Outer visibleNESTED SECRET' }]).
  it('a visible outer text box exposes only its own text — a hidden run nested inside a NESTED text box never leaks in', () => {
    const outerInterior =
      '<w:p><w:r><w:t>Outer visible</w:t></w:r>' + hiddenTextBoxRun('NESTED SECRET') + '</w:p>';
    const body = textBoxHostParagraph(outerInterior);
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['Outer visible']);
    expect(object?.interiorTexts.map((t) => t.text).join('')).not.toContain('NESTED SECRET');
  });

  // Related, "likely same fix" case named in #641: the vanish run does NOT
  // need to sit inside a nested text box at all — a single interior
  // paragraph mixing one plain visible run and one w:rPr>w:vanish run (no
  // nesting) leaked the vanish run's text the same way, via the same
  // depth-unaware extractBlobText walk. One mechanism (collectText's
  // per-w:r vanish skip) closes both shapes.
  it('a single interior paragraph mixing one visible run and one vanish run (no nesting) excludes only the vanish run', () => {
    const interior =
      '<w:p><w:r><w:t>visible part </w:t></w:r>' +
      '<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden part</w:t></w:r></w:p>';
    const body = textBoxHostParagraph(interior);
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    const object = result.paragraphObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['visible part ']);
  });

  // Opposite pairing, pinning EXISTING (unchanged) behavior rather than
  // exercising the new run-vanish walk: when the OUTER box itself is hidden
  // (host paragraph mark vanish), the whole host paragraph is excluded by
  // the pre-existing ADR-087 box-level mechanism before any interior text
  // walk ever runs — so a VISIBLE text box nested inside the hidden outer
  // box is never rescued into its own object. No object at all is produced,
  // same as any other fully-hidden text box.
  it('a hidden outer text box produces no object at all — a visible NESTED text box inside it is not rescued', () => {
    const outerInterior =
      '<w:p><w:r><w:t>Outer text</w:t></w:r>' + textBoxRun('nested visible text') + '</w:p>';
    const body = hostMarkHiddenTextBoxHostParagraph(outerInterior);
    const result = extract(body);

    expect(result.paragraphObjects).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  // Byte-identical round-trip (hard acceptance criterion): the nested
  // w:txbxContent boundary's OOXML is never touched by the fix — only
  // EXCLUDED from the text walk. Compares the SAME nested boundary's
  // serialized bytes from two independently-built trees: (a) the raw
  // preserveOrder blob computeBodyOrder produces BEFORE extraction ever
  // runs, and (b) the captured object's blob AFTER extraction. Both go
  // through the identical parser/builder pipeline, so exact string equality
  // proves the nested subtree round-trips byte-for-byte — not merely that
  // some substring survives.
  it('round-trip byte-identity: the nested text box boundary serializes identically before and after extraction', () => {
    const outerInterior =
      '<w:p><w:r><w:t>Outer visible</w:t></w:r>' + hiddenTextBoxRun('NESTED SECRET') + '</w:p>';
    const body = textBoxHostParagraph(outerInterior);
    const xml = makeDocXml(body);

    const preExtractionHostNode = computeBodyOrder(xml).paragraphBlobs[0]?.[0];
    expect(preExtractionHostNode).toBeDefined();
    const expectedNested = collectAllTxbxContentNodes(preExtractionHostNode as ObjectBlobNode)[1];
    expect(expectedNested).toBeDefined();
    const expectedBytes = createOrderedDocumentXmlBuilder().build([expectedNested]);

    const result = extractBodyObjects(computeBodyOrder(xml), rawParagraphsOf(xml), EMPTY_STYLES);
    const capturedHostNode = result.paragraphObjects[0]?.object.blob[0];
    expect(capturedHostNode).toBeDefined();
    const actualNested = collectAllTxbxContentNodes(capturedHostNode as ObjectBlobNode)[1];
    expect(actualNested).toBeDefined();
    const actualBytes = createOrderedDocumentXmlBuilder().build([actualNested]);

    expect(actualBytes).toBe(expectedBytes);
    expect(actualBytes).toContain('NESTED SECRET');
  });

  // Review finding (medium): the two tests above only pin the run-vanish walk
  // via the text-box CAPTURE path (buildTextBoxObject). collectText is
  // SHARED — buildTableObject calls the exact same anchorInteriorParagraphs /
  // collectText walk (see body-objects.ts's own header comment on
  // anchorInteriorParagraphs) — but nothing in this suite independently
  // verified that for the table path before this test. The direct table
  // analogue of the mixed-run test above: a VISIBLE table cell whose sole
  // paragraph has one plain run and one w:rPr>w:vanish run. Unlike
  // vanishPara's all-vanish cell (line ~402, which never reaches collectText
  // at all — the whole cell/table is classified fully-hidden by the
  // pre-existing ADR-038 path), this cell has a visible run too, so the
  // table is NOT fully hidden and buildTableObject's own collectText call is
  // genuinely exercised.
  it('a visible table cell paragraph mixing one visible run and one vanish run excludes only the vanish run (table analogue)', () => {
    const mixedRunCellPara =
      '<w:p><w:r><w:t>visible part </w:t></w:r>' +
      '<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden part</w:t></w:r></w:p>';
    const body = table(row(cell(mixedRunCellPara)));
    const result = extract(body);

    expect(result.tableObjects).toHaveLength(1);
    const object = result.tableObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['visible part ']);
  });

  // Table analogue of the nested-text-box-inside-a-text-box test above (line
  // ~917): a table cell's own paragraph carries a visible run PLUS a nested
  // drawing (text box) run whose interior is hidden (w:rPr>w:vanish). The
  // cell paragraph is visible overall (its own text is non-empty), so
  // buildTableObject treats it as ONE anchored leaf via extractBlobText —
  // proving the nested hidden run's text never leaks into interiorTexts via
  // the table capture path, not merely the text-box one.
  it('a table cell with a nested hidden text box exposes only its own visible text — the nested vanish run never leaks in (table analogue)', () => {
    const cellParaWithNestedHiddenBox =
      '<w:p><w:r><w:t>cell visible</w:t></w:r>' +
      hiddenTextBoxRun('NESTED TABLE SECRET') +
      '</w:p>';
    const body = table(row(cell(cellParaWithNestedHiddenBox)));
    const result = extract(body);

    expect(result.tableObjects).toHaveLength(1);
    const object = result.tableObjects[0]?.object;
    expect(object?.interiorTexts.map((t) => t.text)).toEqual(['cell visible']);
    expect(object?.interiorTexts.map((t) => t.text).join('')).not.toContain('NESTED TABLE SECRET');
  });
});

describe('extractBodyObjects — #633 investigation: decorative asterisk rule rows are VERBATIM inside a captured object (refutation, not a bug)', () => {
  // #633 investigation outcome, pinned positively rather than left as a
  // silent absence of a suppression branch: a rule-row-only interior
  // paragraph inside a captured text box (or table — see the sibling test
  // below) is captured VERBATIM, exactly like any other interior text.
  // ADR-072 decision 14 (#300) already establishes this — a captured
  // table/text-box's cell text is a faithful, out-of-band, VERBATIM mirror
  // of the source document, never re-run through the paragraph-tier
  // note-region/rule-row engine — and
  // note-region-corpus.integration.test.ts's own OBJECT_VERBATIM_TABLE-scoped
  // regression test pins the real hidden-text-test.docx fixture's body table
  // rendering its 4 asterisk-rule cells verbatim as exactly that invariant.
  // Suppressing it here would silently reinterpret locked object content —
  // the opposite of ADR-072's no-silent-loss posture — and would break that
  // existing test. See hidden-text.integration.test.ts's own narrowed
  // bare-asterisk assertion (ADR-092) for the other half of this
  // investigation: the corpus-gated #294 failure was a test-assertion gap,
  // not a parser defect.
  it('a rule-row-only interior paragraph inside a text box is captured verbatim, not suppressed', () => {
    const body = textBoxParagraph('*****');
    const result = extract(body);

    expect(result.paragraphObjects).toHaveLength(1);
    expect(result.paragraphObjects[0]?.object.interiorTexts.map((t) => t.text)).toEqual(['*****']);
  });

  it('a rule-row-only interior cell paragraph inside a table is captured verbatim, not suppressed', () => {
    const body = table(row(cell(para('*****'))));
    const result = extract(body);

    expect(result.tableObjects).toHaveLength(1);
    expect(result.tableObjects[0]?.object.interiorTexts.map((t) => t.text)).toEqual(['*****']);
  });
});
