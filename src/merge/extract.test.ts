import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateDocx } from '../generator/index.js';
import { extractContentControls } from './extract.js';
import { MergeError } from './error.js';
import type { SpecTree } from '../ast/types.js';

const PART_ID = '00000000-0000-0000-0000-000000000002';
const ART_ID = '00000000-0000-0000-0000-000000000003';
const PR1_ID = '00000000-0000-0000-0000-000000000004';
const NOTE_ID = '00000000-0000-0000-0000-000000000005';
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = '33333333-3333-3333-3333-333333333333';
const U4 = '44444444-4444-4444-4444-444444444444';

const TREE: SpecTree = {
  id: '00000000-0000-0000-0000-000000000001',
  section: '27 21 00',
  title: 'Structured Cabling',
  parts: [
    {
      id: PART_ID,
      type: 'part',
      text: 'GENERAL',
      meta: {},
      children: [
        {
          id: ART_ID,
          type: 'article',
          text: 'REFERENCES',
          meta: {},
          children: [
            { id: PR1_ID, type: 'pr1', text: 'Referenced Documents', meta: {}, children: [] },
            { id: NOTE_ID, type: 'note', text: 'Verify local conditions.', meta: {}, children: [] },
          ],
        },
      ],
    },
  ],
};

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function craftDocx(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const sdt = (uuid: string, inner: string): string =>
  `<w:sdt><w:sdtPr><w:tag w:val="specr-uuid-${uuid}"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;
const para = (content: string): string => `<w:p>${content}</w:p>`;
const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

/** DrawingML text box: w:r > w:drawing > wp:inline > a:graphic > a:graphicData > wps:txbx > w:txbxContent */
const drawingTextBoxRun = (innerXml: string): string =>
  '<w:r><w:drawing><wp:inline><a:graphic><a:graphicData>' +
  `<wps:wsp><wps:txbx><w:txbxContent>${innerXml}</w:txbxContent></wps:txbx></wps:wsp>` +
  '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';

/** VML text box: w:r > w:pict > v:shape > v:textbox > w:txbxContent */
const vmlTextBoxRun = (innerXml: string): string =>
  `<w:r><w:pict><v:shape><v:textbox><w:txbxContent>${innerXml}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`;

const tableCell = (cellXml: string): string => `<w:tc>${cellXml}</w:tc>`;
const tableRow = (cellsXml: readonly string[]): string =>
  `<w:tr>${cellsXml.map(tableCell).join('')}</w:tr>`;
const table = (rowsXml: readonly string[]): string => `<w:tbl>${rowsXml.join('')}</w:tbl>`;

describe('extractContentControls', () => {
  it('roundtrip: recovers every SpecNode id → text from generateDocx output', async () => {
    const buffer = await generateDocx(TREE);
    const result = await extractContentControls(buffer);
    expect(result.controlled.get(PART_ID)).toBe('GENERAL');
    expect(result.controlled.get(ART_ID)).toBe('REFERENCES');
    expect(result.controlled.get(PR1_ID)).toBe('Referenced Documents');
    expect(result.controlled.get(NOTE_ID)).toBe('Verify local conditions.');
    expect(result.controlled.size).toBe(4);
  });

  it('roundtrip: synthetic title paragraph is the only orphan; no track changes', async () => {
    const buffer = await generateDocx(TREE);
    const result = await extractContentControls(buffer);
    expect(result.orphans).toEqual([
      { text: 'SECTION 27 21 00 — Structured Cabling', index: 0, afterUuid: undefined },
    ]);
    expect(result.trackChanges.present).toBe(false);
    expect(result.trackChanges.records).toEqual([]);
  });

  it('bare w:p outside any w:sdt → orphan with document-order index', async () => {
    const buffer = await craftDocx(
      sdt(U1, para(run('controlled text'))) + para(run('orphan text'))
    );
    const result = await extractContentControls(buffer);
    expect(result.controlled.size).toBe(1);
    expect(result.controlled.get(U1)).toBe('controlled text');
    expect(result.orphans).toEqual([{ text: 'orphan text', index: 1, afterUuid: U1 }]);
  });

  it('orphan between two controlled paragraphs → afterUuid is the nearest preceding controlled uuid', async () => {
    const body =
      sdt(U1, para(run('first controlled'))) +
      para(run('orphan between')) +
      sdt(U2, para(run('second controlled')));
    const result = await extractContentControls(await craftDocx(body));
    expect(result.orphans).toEqual([{ text: 'orphan between', index: 1, afterUuid: U1 }]);
  });

  it('two orphans in a row after the same controlled paragraph share one afterUuid', async () => {
    const body =
      sdt(U1, para(run('first controlled'))) + para(run('orphan one')) + para(run('orphan two'));
    const result = await extractContentControls(await craftDocx(body));
    expect(result.orphans).toEqual([
      { text: 'orphan one', index: 1, afterUuid: U1 },
      { text: 'orphan two', index: 2, afterUuid: U1 },
    ]);
  });

  it('w:sdt without a specr-uuid- tag → its paragraph is an orphan', async () => {
    const body =
      '<w:sdt><w:sdtPr><w:tag w:val="other-tag"/></w:sdtPr><w:sdtContent>' +
      para(run('foreign control')) +
      '</w:sdtContent></w:sdt>';
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.size).toBe(0);
    expect(result.orphans).toEqual([{ text: 'foreign control', index: 0, afterUuid: undefined }]);
  });

  it('w:ins is virtually accepted: text included, record carries uuid/author/date', async () => {
    const body = sdt(
      U1,
      para(
        run('Base ') +
          `<w:ins w:author="OwnerA" w:date="2026-05-20T10:00:00Z">${run('added')}</w:ins>`
      )
    );
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('Base added');
    expect(result.trackChanges.present).toBe(true);
    expect(result.trackChanges.records).toEqual([
      { kind: 'ins', uuid: U1, text: 'added', author: 'OwnerA', date: '2026-05-20T10:00:00Z' },
    ]);
  });

  it('w:del is virtually rejected: text excluded, record captured (w:delText)', async () => {
    const body = sdt(
      U1,
      para(
        run('Keep') +
          '<w:del w:author="OwnerA" w:date="2026-05-20T10:00:00Z">' +
          '<w:r><w:delText xml:space="preserve"> removed</w:delText></w:r></w:del>'
      )
    );
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('Keep');
    expect(result.trackChanges.records).toEqual([
      { kind: 'del', uuid: U1, text: ' removed', author: 'OwnerA', date: '2026-05-20T10:00:00Z' },
    ]);
  });

  it('whitespace-only paragraphs are skipped and do not consume an index', async () => {
    const body = para(run('   ')) + para(run('real text'));
    const result = await extractContentControls(await craftDocx(body));
    expect(result.orphans).toEqual([{ text: 'real text', index: 0, afterUuid: undefined }]);
  });

  it('normalizes w:tab → tab, w:br → newline, strips w:noBreakHyphen', async () => {
    const body = sdt(
      U1,
      para(
        '<w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:noBreakHyphen/><w:t>d</w:t></w:r>'
      )
    );
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('a\tb\ncd');
  });

  it('w:pPr tab-stop definitions do not leak phantom tabs into text', async () => {
    const body = sdt(
      U1,
      para('<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' + run('clean'))
    );
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('clean');
  });

  it('rejects a non-zip buffer with MergeError and preserved cause', async () => {
    const err = await extractContentControls(Buffer.from('definitely not a zip')).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(MergeError);
    expect((err as MergeError).message).toBe('not a valid DOCX buffer');
    expect((err as MergeError).cause).toBeDefined();
  });

  it('zip without word/document.xml → MergeError', async () => {
    const zip = new JSZip();
    zip.file('placeholder.txt', 'not a docx');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(extractContentControls(buffer)).rejects.toMatchObject({
      message: 'DOCX missing word/document.xml',
    });
  });

  it('malformed document.xml → MergeError with cause', async () => {
    // fast-xml-parser v5 (preserveOrder) is lenient about mismatched closing tags
    // (it silently treats <w:p></w:body> as an empty <w:p>), so an unterminated tag
    // is used to force the parser to throw. See plan NOTE on the malformed-XML test.
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document><w:body><w:p');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const err = await extractContentControls(buffer).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(MergeError);
    expect((err as MergeError).message).toBe('failed to parse word/document.xml');
    expect((err as MergeError).cause).toBeDefined();
  });

  it('multiple paragraphs inside one sdt are concatenated with newline, not dropped', async () => {
    // Regression: Word user pressing Enter inside a content control splits it into
    // two w:p under one sdt. Previous Map.set was last-wins; now concatenates.
    const body = sdt(U1, para(run('first para')) + para(run('second para'))) + para(run('tail'));
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('first para\nsecond para');
    // tail is the third non-empty paragraph encountered (index 2 — two sdt paragraphs consumed 0 and 1)
    expect(result.orphans).toEqual([{ text: 'tail', index: 2, afterUuid: U1 }]);
  });

  // KNOWN AMBIGUITY: table-cell paragraphs are not generator output. They surface
  // as orphans but are deliberately kept ANCHORLESS (afterUuid undefined) even when
  // a controlled paragraph precedes the table (#374): a w:tbl cell has no CSI tier,
  // so anchoring — and later flattening — it onto a body sibling would corrupt
  // structure. Anchorless orphans flow into the merge's anchorless-addition
  // rejection instead of silently applying. The non-table paragraph after the table
  // anchors normally, proving the flag scopes to the table subtree only.
  it('table-cell paragraphs stay anchorless even when a controlled paragraph precedes the table', async () => {
    const body =
      sdt(U1, para(run('controlled before table'))) +
      `<w:tbl><w:tr><w:tc>${para(run('cell A'))}</w:tc><w:tc>${para(run('cell B'))}</w:tc></w:tr></w:tbl>` +
      para(run('after table'));
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('controlled before table');
    expect(result.orphans).toEqual([
      { text: 'cell A', index: 1, afterUuid: undefined },
      { text: 'cell B', index: 2, afterUuid: undefined },
      { text: 'after table', index: 3, afterUuid: U1 },
    ]);
  });
});

// gap-1 (#520): a text box's interior specr-uuid anchor lives inside a w:r
// (run content), which the pre-existing walk only visits via visibleText/
// visitRunNode — never via walkBlocks, the ONLY place readSdtUuid was called.
// Without a dedicated w:drawing/w:pict branch, the interior sdt's text was
// silently absorbed into the host paragraph's own text (generic run-content
// recursion) instead of being captured under its own uuid.
describe('extractContentControls — text-box interior anchors (#520 gap-1)', () => {
  it('DrawingML text box: interior anchor captured under its own uuid, not bled into host paragraph text', async () => {
    const body = sdt(
      U1,
      para(run('before ') + drawingTextBoxRun(sdt(U2, para(run('inside box')))) + run(' after'))
    );
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('before  after');
    expect(result.controlled.get(U2)).toBe('inside box');
    expect(result.controlled.size).toBe(2);
  });

  it('VML text box: interior anchor captured under its own uuid, not bled into host paragraph text', async () => {
    const body = sdt(
      U1,
      para(run('before ') + vmlTextBoxRun(sdt(U2, para(run('inside box')))) + run(' after'))
    );
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('before  after');
    expect(result.controlled.get(U2)).toBe('inside box');
    expect(result.controlled.size).toBe(2);
  });

  it('a drawing with no specr-uuid anchor inside contributes no text and no controlled entry', async () => {
    const body = sdt(
      U1,
      para(run('before ') + drawingTextBoxRun(para(run('unanchored box text'))) + run(' after'))
    );
    const result = await extractContentControls(await craftDocx(body));
    expect(result.controlled.get(U1)).toBe('before  after');
    expect(result.controlled.size).toBe(1);
  });
});

describe('extractContentControls — object-block extraction (#520)', () => {
  it('detects a w:tbl object block with correct kind and interiorUuids in document order', async () => {
    const body = table([
      tableRow([sdt(U1, para(run('A1'))), sdt(U2, para(run('B1')))]),
      tableRow([sdt(U3, para(run('A2'))), sdt(U4, para(run('B2')))]),
    ]);
    const result = await extractContentControls(await craftDocx(body));
    expect(result.objectBlocks).toHaveLength(1);
    expect(result.objectBlocks[0]?.fingerprint.kind).toBe('table');
    expect(result.objectBlocks[0]?.interiorUuids).toEqual([U1, U2, U3, U4]);
  });

  it('detects a text-box drawing object block with correct kind and interiorUuids', async () => {
    const body = para(drawingTextBoxRun(sdt(U1, para(run('box text')))));
    const result = await extractContentControls(await craftDocx(body));
    expect(result.objectBlocks).toHaveLength(1);
    expect(result.objectBlocks[0]?.fingerprint.kind).toBe('textBox');
    expect(result.objectBlocks[0]?.interiorUuids).toEqual([U1]);
  });

  it('a document with no tables or drawings has no object blocks', async () => {
    const result = await extractContentControls(await craftDocx(para(run('plain text'))));
    expect(result.objectBlocks).toEqual([]);
  });

  it('never double-detects: a table nested inside another table cell yields exactly one object block', async () => {
    const nestedTable = table([tableRow([sdt(U2, para(run('nested cell')))])]);
    const body = table([tableRow([sdt(U1, para(run('outer cell'))) + nestedTable])]);
    const result = await extractContentControls(await craftDocx(body));
    expect(result.objectBlocks).toHaveLength(1);
    expect(result.objectBlocks[0]?.interiorUuids).toEqual([U1, U2]);
  });

  it('never double-detects: a table nested inside a text box yields exactly one object block (kind textBox)', async () => {
    // The outer w:drawing is detected first (walkObjectBlocks visits document
    // order top-down), so inBlock folds the interior w:tbl into it — the same
    // dedup as table-in-table, but across the two different OBJECT_BLOCK_TAGS.
    const nestedTable = table([tableRow([sdt(U2, para(run('nested table cell')))])]);
    const body = para(drawingTextBoxRun(sdt(U1, para(run('box text'))) + nestedTable));
    const result = await extractContentControls(await craftDocx(body));
    expect(result.objectBlocks).toHaveLength(1);
    expect(result.objectBlocks[0]?.fingerprint.kind).toBe('textBox');
    expect(result.objectBlocks[0]?.interiorUuids).toEqual([U1, U2]);
  });

  it('never double-detects: a text box nested inside a table cell yields exactly one object block (kind table)', async () => {
    // Reverse nesting from the above — a w:drawing inside a w:tbl cell folds
    // into the outer table block rather than being re-detected on its own.
    const cellContent =
      sdt(U1, para(run('outer cell'))) + para(drawingTextBoxRun(sdt(U2, para(run('inside box')))));
    const body = table([tableRow([cellContent])]);
    const result = await extractContentControls(await craftDocx(body));
    expect(result.objectBlocks).toHaveLength(1);
    expect(result.objectBlocks[0]?.fingerprint.kind).toBe('table');
    expect(result.objectBlocks[0]?.interiorUuids).toEqual([U1, U2]);
  });
});
