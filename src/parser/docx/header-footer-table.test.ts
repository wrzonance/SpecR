import { describe, it, expect } from 'vitest';
import { captureRegion } from './header-footer-region.js';

// Exercises captureTablesForRegion's own capture rules (#309, ADR-071)
// through captureRegion — the module's public boundary (CLAUDE.md: "test at
// module API boundaries, not internals"), the same way
// header-footer-region.test.ts already tests captureRegion's paragraph-cell
// rules. header-footer-region.test.ts's own table describe block covers only
// the region-level structural invariant (root-level detection, merging
// alongside a captured paragraph); this file covers the table's internal
// shape.

const KNOWN = { section: '09 91 26', title: 'STAINING AND TRANSPARENT FINISHING' };

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function makeHdrXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${bodyXml}</w:hdr>`;
}

function paragraph(runsXml: string): string {
  return `<w:p>${runsXml}</w:p>`;
}

function textRun(text: string): string {
  return `<w:r><w:t>${text}</w:t></w:r>`;
}

// A resolvable drawing-run fixture (#487, ADR-071 decision 4) — mirrors
// header-footer-region.test.ts's own pngBytes/imageDrawingRun fixtures so the
// "drops an image run from cell content" test below can supply a genuinely
// resolvable rId + mediaByRId, the only way to prove the table-cell
// pre-filter runs BEFORE buildCellContent's image-resolving branch rather
// than merely lacking anything to resolve.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(totalLength = 16): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  bytes.set(PNG_SIGNATURE);
  return bytes;
}

function imageDrawingRun(rId: string, cx = '914400', cy = '609600'): string {
  return (
    '<w:r><w:drawing><wp:inline>' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:docPr id="1"/>' +
    '<a:graphic><a:graphicData><pic:pic><pic:blipFill>' +
    `<a:blip r:embed="${rId}"/>` +
    '</pic:blipFill></pic:pic></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r>'
  );
}

function styledTextRun(text: string, rPrXml: string): string {
  return `<w:r><w:rPr>${rPrXml}</w:rPr><w:t>${text}</w:t></w:r>`;
}

function cell(pXml: string, tcPrXml = ''): string {
  const tcPr = tcPrXml === '' ? '' : `<w:tcPr>${tcPrXml}</w:tcPr>`;
  return `<w:tc>${tcPr}${pXml}</w:tc>`;
}

function row(cellsXml: string): string {
  return `<w:tr>${cellsXml}</w:tr>`;
}

function table(rowsXml: string, tblPrXml = '', tblGridXml = ''): string {
  return `<w:tbl>${tblPrXml}${tblGridXml}${rowsXml}</w:tbl>`;
}

function gridCol(widthTwips: number): string {
  return `<w:gridCol w:w="${widthTwips}"/>`;
}

function gridSpan(n: number): string {
  return `<w:gridSpan w:val="${n}"/>`;
}

// Word's single-tag field shorthand (#485) — parallels
// header-footer-region.test.ts's own simpleFieldRun helper; kept local to
// this file rather than imported, per this suite's existing convention of
// each header-footer test file owning its own XML-fragment builders (see
// textRun/paragraph/cell above, all duplicated rather than shared).
function simpleFieldRun(instr: string, cachedText: string): string {
  return `<w:fldSimple w:instr="${instr}"><w:r><w:t>${cachedText}</w:t></w:r></w:fldSimple>`;
}

describe('captureRegion — simple table capture (#309, ADR-071)', () => {
  it('captures a multi-row, multi-cell table into region.table with literal content per cell', () => {
    const xml = makeHdrXml(
      table(
        row(cell(paragraph(textRun('Drawing No.'))) + cell(paragraph(textRun('Sheet 1 of 3')))) +
          row(cell(paragraph(textRun('Approved by:'))) + cell(paragraph(textRun(''))))
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([
      {
        cells: [
          { content: [{ kind: 'literal', text: 'Drawing No.' }] },
          { content: [{ kind: 'literal', text: 'Sheet 1 of 3' }] },
        ],
      },
      { cells: [{ content: [{ kind: 'literal', text: 'Approved by:' }] }, {}] },
    ]);
    expect(result.unmodeled).toEqual([]);
  });

  it('maps a cell whose text matches the known section identity onto a modeled field, not literal text', () => {
    const xml = makeHdrXml(table(row(cell(paragraph(textRun('09 91 26'))))));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([
      { cells: [{ content: [{ kind: 'sectionNumber' }] }] },
    ]);
  });

  it('captures a bold/colored run onto a cell style, mirroring cell-style capture for left/center/right', () => {
    const xml = makeHdrXml(
      table(row(cell(paragraph(styledTextRun('Approved', '<w:b/><w:color w:val="FF0000"/>')))))
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows[0]?.cells[0]?.style).toEqual({ bold: true, color: 'FF0000' });
  });

  it('captures columnSpan from w:gridSpan on a cell', () => {
    const xml = makeHdrXml(table(row(cell(paragraph(textRun('Wide cell')), gridSpan(2)))));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows[0]?.cells[0]?.columnSpan).toBe(2);
  });

  it('captures columnWidths from w:tblGrid/w:gridCol, in document order', () => {
    const xml = makeHdrXml(
      table(
        row(cell(paragraph(textRun('A'))) + cell(paragraph(textRun('B')))),
        '',
        `<w:tblGrid>${gridCol(1440)}${gridCol(2880)}</w:tblGrid>`
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.columnWidths).toEqual([1440, 2880]);
  });

  // KNOWN AMBIGUITY: HeaderFooterTableSchema models a single uniform border
  // for a table (mirrors "first run/paragraph wins" elsewhere in this
  // capture pipeline), so when per-edge w:tblBorders styles differ, only
  // the w:top edge is captured as the table's representative border
  // definition; other edges' distinct styling is discarded.
  it('captures the table borders from the w:tblBorders w:top edge as a single uniform rule line', () => {
    const xml = makeHdrXml(
      table(
        row(cell(paragraph(textRun('A')))),
        '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="double" w:sz="8"/></w:tblBorders></w:tblPr>'
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.borders).toEqual({
      enabled: true,
      style: 'single',
      widthTwips: 10,
      color: '000000',
    });
  });

  it('leaves an empty cell (no content-bearing paragraph) present in row.cells with no content, preserving column position', () => {
    const xml = makeHdrXml(table(row(cell(paragraph('')) + cell(paragraph(textRun('B'))))));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([
      { cells: [{}, { content: [{ kind: 'literal', text: 'B' }] }] },
    ]);
  });

  // A cell's paragraph can be wrapped in a w:sdt content control (or a
  // w:ins/w:del tracked-change wrapper) rather than sitting as a direct w:p
  // child — region capture already deep-scans runs for exactly this, and this
  // module deep-scans for wrapped NESTED tables. A shallow `tc['w:p']` read
  // would capture such a cell as EMPTY with no unmodeled entry, a silent drop
  // (ADR-068 criteria 3/4); collectCellParagraphs finds the wrapped paragraph.
  it('captures a cell whose only paragraph is wrapped in a w:sdt content control, never as an empty cell', () => {
    const wrappedCell = `<w:tc><w:sdt><w:sdtContent>${paragraph(textRun('Wrapped'))}</w:sdtContent></w:sdt></w:tc>`;
    const xml = makeHdrXml(table(row(wrappedCell + cell(paragraph(textRun('Direct'))))));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([
      {
        cells: [
          { content: [{ kind: 'literal', text: 'Wrapped' }] },
          { content: [{ kind: 'literal', text: 'Direct' }] },
        ],
      },
    ]);
    expect(result.unmodeled).toEqual([]);
  });

  // Confirms columnWidths/borders are genuinely ABSENT keys (compact() drops
  // undefined entries entirely), not merely undefined-valued — toStrictEqual
  // (unlike toEqual) distinguishes a missing key from a key set to undefined,
  // so this catches any regression that starts fabricating either hint.
  it('captures a table with no columnWidths or borders key present when the source has no w:tblGrid or w:tblBorders', () => {
    const xml = makeHdrXml(table(row(cell(paragraph(textRun('A'))))));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table).toStrictEqual({
      rows: [{ cells: [{ content: [{ kind: 'literal', text: 'A' }] }] }],
    });
  });
});

describe('captureRegion — per-item drops inside an otherwise-capturable table (ADR-071 decision 4)', () => {
  it('drops an image run from cell content as unmodeled, never as cell content — the surrounding table is still captured, even when mediaByRId would resolve it', () => {
    const rId = 'rId7';
    const mediaByRId = new Map([[rId, pngBytes()]]);
    const xml = makeHdrXml(
      table(row(cell(paragraph(`${textRun('Logo: ')}${imageDrawingRun(rId)}`))))
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN, mediaByRId);
    expect(result.region?.table?.rows).toEqual([
      { cells: [{ content: [{ kind: 'literal', text: 'Logo: ' }] }] },
    ]);
    const cellContent = result.region?.table?.rows[0]?.cells[0]?.content ?? [];
    expect(cellContent.some((field) => field.kind === 'image')).toBe(false);
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'image' })
    );
  });

  it('captures only the first content-bearing paragraph in a cell; a second is unmodeled extraParagraph, never merged', () => {
    const xml = makeHdrXml(
      table(row(cell(paragraph(textRun('First')) + paragraph(textRun('Second')))))
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([
      { cells: [{ content: [{ kind: 'literal', text: 'First' }] }] },
    ]);
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'extraParagraph' })
    );
  });
});

describe('captureRegion — structural table disqualification (ADR-071 decision 4)', () => {
  it('disqualifies the whole table when a cell contains a nested w:tbl, preserving it whole as unmodeled', () => {
    const nestedTbl = table(row(cell(paragraph(textRun('nested')))));
    const xml = makeHdrXml(table(row(cell(nestedTbl))));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table).toBeUndefined();
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'table' })
    );
  });

  it('disqualifies the whole table when a cell carries a vertical merge (w:vMerge), preserving it whole as unmodeled', () => {
    const xml = makeHdrXml(
      table(
        row(cell(paragraph(textRun('A')), '<w:vMerge w:val="restart"/>')) +
          row(cell(paragraph(textRun('')), '<w:vMerge/>'))
      )
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table).toBeUndefined();
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'table' })
    );
  });

  it('never fabricates a table from a w:tbl with zero rows — disqualified whole, like any other malformed table', () => {
    const xml = makeHdrXml(table(''));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table).toBeUndefined();
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'table' })
    );
  });

  it('disqualifies the whole table when a cell contains a nested w:tbl wrapped in a w:sdt content control, preserving it whole as unmodeled — never silently dropped as an empty cell', () => {
    const nestedTbl = table(row(cell(paragraph(textRun('nested')))));
    const sdtWrappedNestedTbl = `<w:sdt><w:sdtContent>${nestedTbl}</w:sdtContent></w:sdt>`;
    const xml = makeHdrXml(table(row(cell(sdtWrappedNestedTbl))));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table).toBeUndefined();
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'table' })
    );
  });
});

describe('captureRegion — "first table wins" (ADR-071 decision 5, mirrors ADR-068)', () => {
  it('drops a second, otherwise-valid table whole as unmodeled — never inspected for salvageable content', () => {
    const firstTable = table(row(cell(paragraph(textRun('First')))));
    const secondTable = table(row(cell(paragraph(textRun('Second')))));
    const xml = makeHdrXml(`${firstTable}${secondTable}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([
      { cells: [{ content: [{ kind: 'literal', text: 'First' }] }] },
    ]);
    expect(result.unmodeled).toHaveLength(1);
    expect(result.unmodeled[0]).toMatchObject({
      variant: 'default',
      region: 'header',
      kind: 'table',
    });
  });

  it('disqualifies only the FIRST table when it is structurally unsupported; a later, otherwise-valid table is still not captured', () => {
    const nestedTbl = table(row(cell(paragraph(textRun('nested')))));
    const badFirstTable = table(row(cell(nestedTbl)));
    const validSecondTable = table(row(cell(paragraph(textRun('Second')))));
    const xml = makeHdrXml(`${badFirstTable}${validSecondTable}`);
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table).toBeUndefined();
    expect(result.unmodeled.filter((u) => u.kind === 'table')).toHaveLength(2);
  });
});

// #485 — captureTableCell's existing `collapseComplexFields(runsOf(first))`
// call (zero production changes in THIS file) gains w:fldSimple support for
// free once header-footer-region.ts's runsOf/paragraphHasContent learn the
// w:fldSimple terminal: proves the traversal-layer fix wired in
// header-footer-region.ts propagates through to the table-cell path, the
// same way it already does for the region/paragraph path (see
// header-footer-region.test.ts's own w:fldSimple describe block).
describe('captureRegion — table-cell w:fldSimple field recognition (#485, table-cell parity)', () => {
  it('recognizes a PAGE field authored as w:fldSimple inside a table cell as a modeled field, matching the w:fldChar-authored equivalent', () => {
    const xml = makeHdrXml(table(row(cell(paragraph(simpleFieldRun(' PAGE ', '3'))))));
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([
      { cells: [{ content: [{ kind: 'pageNumber' }] }] },
    ]);
    expect(result.unmodeled).toEqual([]);
  });

  it('preserves an unrecognized field code (e.g. STYLEREF) authored as w:fldSimple inside a table cell as unmodeled unrecognizedField, never guessed into a known field — the surrounding table is still captured', () => {
    const xml = makeHdrXml(
      table(row(cell(paragraph(simpleFieldRun(' STYLEREF Heading1 ', 'Some Style Text')))))
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([{ cells: [{}] }]);
    expect(result.unmodeled).toContainEqual(
      expect.objectContaining({ variant: 'default', region: 'header', kind: 'unrecognizedField' })
    );
  });

  it('recognizes a w:fldSimple field alongside literal text in the same cell, preserving run order (parity with paragraph-level buildCellContent)', () => {
    const xml = makeHdrXml(
      table(row(cell(paragraph(`${textRun('Page ')}${simpleFieldRun(' PAGE ', '3')}`))))
    );
    const result = captureRegion(xml, 'bottom', 'default', 'header', KNOWN);
    expect(result.region?.table?.rows).toEqual([
      {
        cells: [
          {
            content: [{ kind: 'literal', text: 'Page ' }, { kind: 'pageNumber' }],
          },
        ],
      },
    ]);
    expect(result.unmodeled).toEqual([]);
  });
});
