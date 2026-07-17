import { describe, it, expect } from 'vitest';
import { extractBodyObjects } from './body-objects.js';
import { computeBodyOrder } from './body-order.js';
import { createDocumentXmlParser, createOrderedDocumentXmlBuilder, toArray } from './xml-utils.js';
import { buildStyleMap } from './styles.js';
import { UUID_TAG_PREFIX } from '../../ast/index.js';
import type { StyleMap } from './types.js';
import type { BodyObjectExtractionResult } from './body-objects.js';

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
