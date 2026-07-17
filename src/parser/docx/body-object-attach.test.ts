import { describe, it, expect } from 'vitest';
import { captureBodyObjectsForTree } from './body-object-attach.js';
import { buildStyleMap } from './styles.js';
import type { StyleMap } from './types.js';

// Mirrors body-objects.test.ts's own fixture builders exactly — same
// namespace prefixes, same textBoxParagraph/table/row/cell shapes — so this
// test feeds captureBodyObjectsForTree realistic OOXML rather than reinventing
// a second, possibly-diverging fixture dialect.
const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"',
].join(' ');

const EMPTY_STYLES: StyleMap = buildStyleMap(
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

function cell(paragraphsXml: string): string {
  return `<w:tc>${paragraphsXml}</w:tc>`;
}

function row(cellsXml: string): string {
  return `<w:tr>${cellsXml}</w:tr>`;
}

function table(rowsXml: string): string {
  return `<w:tbl>${rowsXml}</w:tbl>`;
}

// One drawingml text box run, inline, whose txbxContent holds exactly one
// interior paragraph carrying `interiorText`.
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

describe('captureBodyObjectsForTree — paragraph/table attachment ordering (#300)', () => {
  // ADR-072-decision-10-adjacent ordering rule documented on buildAttachmentMap
  // (body-object-attach.ts): when a table's precedingParagraphIndex collides
  // with a paragraph (text box) object's own paragraphIndex — i.e. a table
  // immediately follows a paragraph that itself hosts a drawing — the text
  // box must attach FIRST at that shared key, since its content is authored
  // strictly before the table in document order.
  it('attaches the text box before the table when both key on the same paragraph index', () => {
    const body = textBoxParagraph('box text') + table(row(cell(para('cell one'))));
    const xml = makeDocXml(body);

    const attachment = captureBodyObjectsForTree(xml, EMPTY_STYLES);

    expect(attachment.objectsBeforeFirst).toEqual([]);
    const colliding = attachment.objectsByPrecedingIndex.get(0);
    expect(colliding).toHaveLength(2);
    expect(colliding?.[0]?.type).toBe('object');
    expect(colliding?.[0]?.meta.object?.kind).toBe('textBox');
    expect(colliding?.[1]?.meta.object?.kind).toBe('table');
  });

  it('prepends a table with no preceding paragraph to objectsBeforeFirst', () => {
    const body = table(row(cell(para('lead table')))) + para('intro');
    const xml = makeDocXml(body);

    const attachment = captureBodyObjectsForTree(xml, EMPTY_STYLES);

    expect(attachment.objectsBeforeFirst).toHaveLength(1);
    expect(attachment.objectsBeforeFirst[0]?.meta.object?.kind).toBe('table');
    expect(attachment.objectsByPrecedingIndex.size).toBe(0);
  });

  it('keys a table on its own preceding paragraph index when no collision exists', () => {
    const body = para('intro') + table(row(cell(para('cell one')))) + para('outro');
    const xml = makeDocXml(body);

    const attachment = captureBodyObjectsForTree(xml, EMPTY_STYLES);

    const atZero = attachment.objectsByPrecedingIndex.get(0);
    expect(atZero).toHaveLength(1);
    expect(atZero?.[0]?.meta.object?.kind).toBe('table');
  });
});

describe('captureBodyObjectsForTree — object/objectText node shape', () => {
  it('builds an object node whose objectText children carry the captured interior text', () => {
    const body = table(row(cell(para('cell one'))));
    const xml = makeDocXml(body);

    const attachment = captureBodyObjectsForTree(xml, EMPTY_STYLES);
    expect(attachment.objectsBeforeFirst).toHaveLength(1);
    const object = attachment.objectsBeforeFirst[0];
    expect(object?.type).toBe('object');
    expect(object?.children).toHaveLength(1);
    expect(object?.children[0]?.type).toBe('objectText');
    expect(object?.children[0]?.text).toBe('cell one');
  });
});

describe('captureBodyObjectsForTree — body-drawing-skipped warning aggregation', () => {
  it('emits one aggregate warning naming the dropped kind when a chart is out of scope', () => {
    const xml = makeDocXml(chartParagraph());

    const attachment = captureBodyObjectsForTree(xml, EMPTY_STYLES);

    expect(attachment.warning?.type).toBe('body-drawing-skipped');
    expect(attachment.warning?.suggestion).toContain('1 chart');
  });

  it('omits the warning entirely when nothing was dropped', () => {
    const xml = makeDocXml(para('plain text, no objects'));

    const attachment = captureBodyObjectsForTree(xml, EMPTY_STYLES);

    expect(attachment.warning).toBeUndefined();
  });
});
