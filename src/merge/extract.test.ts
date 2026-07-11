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

  // KNOWN AMBIGUITY: table-cell paragraphs are not generator output; they surface
  // as individual orphans with document-order indexes (never silently dropped).
  it('table cell paragraphs surface as orphans with document-order indexes', async () => {
    const body =
      `<w:tbl><w:tr><w:tc>${para(run('cell A'))}</w:tc><w:tc>${para(run('cell B'))}</w:tc></w:tr></w:tbl>` +
      para(run('after table'));
    const result = await extractContentControls(await craftDocx(body));
    expect(result.orphans).toEqual([
      { text: 'cell A', index: 0, afterUuid: undefined },
      { text: 'cell B', index: 1, afterUuid: undefined },
      { text: 'after table', index: 2, afterUuid: undefined },
    ]);
  });
});
