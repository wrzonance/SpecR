import { describe, it, expect } from 'vitest';
import { extractTables } from './tables.js';
import { buildStyleMap } from './styles.js';
import { ParserError } from '../error.js';

const EMPTY_STYLES = buildStyleMap(
  `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
);

function makeDocXml(tables: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${tables}</w:body></w:document>`;
}

function visiblePara(text: string): string {
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

describe('extractTables — hidden vs visible classification', () => {
  it('classifies a table hidden when every text-bearing cell paragraph carries a run-level w:vanish', () => {
    const xml = makeDocXml(table(row(cell(vanishPara('secret A')) + cell(vanishPara('secret B')))));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([['secret A', 'secret B']]);
    expect(result.visibleCount).toBe(0);
  });

  // Pins the reuse decision (design decision #4): table-cell hiddenness consults the
  // full 3-signal resolveParagraphVanish via isParagraphVanish, including paragraph-
  // STYLE vanish, not just a run-level check.
  it('classifies a table hidden via paragraph-style vanish alone, with no run-level w:vanish', () => {
    const styles = buildStyleMap(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:style w:styleId="Hidden" w:type="paragraph"><w:name w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style>` +
        `</w:styles>`
    );
    const styledPara = `<w:p><w:pPr><w:pStyle w:val="Hidden"/></w:pPr><w:r><w:t>via style</w:t></w:r></w:p>`;
    const xml = makeDocXml(table(row(cell(styledPara))));
    const result = extractTables(xml, styles);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([['via style']]);
  });

  it('classifies a table visible when no cell paragraph is vanish', () => {
    const xml = makeDocXml(table(row(cell(visiblePara('a')) + cell(visiblePara('b')))));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(0);
    expect(result.visibleCount).toBe(1);
  });

  it('classifies a table visible when only some cells are vanish (mixed)', () => {
    const xml = makeDocXml(table(row(cell(vanishPara('hidden')) + cell(visiblePara('shown')))));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(0);
    expect(result.visibleCount).toBe(1);
  });

  it('classifies an empty table (no text-bearing paragraphs) as visible — no evidence', () => {
    const xml = makeDocXml(table(row(cell('<w:p/>') + cell('<w:p/>'))));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(0);
    expect(result.visibleCount).toBe(1);
  });

  it('returns an empty result when word/document.xml has no w:tbl', () => {
    const xml = makeDocXml(visiblePara('no tables here'));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result).toEqual({ hiddenTables: [], visibleCount: 0 });
  });

  it('classifies multiple tables independently', () => {
    const hidden = table(row(cell(vanishPara('secret'))));
    const visible = table(row(cell(visiblePara('shown'))));
    const xml = makeDocXml(hidden + visible);
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([['secret']]);
    expect(result.visibleCount).toBe(1);
  });

  it('preserves a row with zero w:tc as an empty array', () => {
    const xml = makeDocXml(table(row('') + row(cell(vanishPara('only row with content')))));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([[], ['only row with content']]);
  });

  it('classifies hidden for a vanish run wrapped in a hyperlink', () => {
    const linkedVanish = `<w:p><w:hyperlink><w:r><w:rPr><w:vanish/></w:rPr><w:t>linked secret</w:t></w:r></w:hyperlink></w:p>`;
    const xml = makeDocXml(table(row(cell(linkedVanish))));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([['linked secret']]);
  });

  // KNOWN AMBIGUITY: a w:tbl nested inside a cell (table-within-a-table) is not
  // walked — findTopLevelTables only scans w:body's direct w:tbl children, and
  // parseTableCell only reads a cell's w:p paragraphs, never its w:tbl. The nested
  // table's content is neither retained (if hidden) nor counted (if visible); it is
  // simply invisible to extractTables. Out of scope for #293 (design decision #6).
  it('KNOWN AMBIGUITY: a table nested inside a cell is not discovered — only body-level tables are scanned', () => {
    const nestedHiddenTable = table(row(cell(vanishPara('nested secret'))));
    const outerCell = cell(visiblePara('outer visible') + nestedHiddenTable);
    const xml = makeDocXml(table(row(outerCell)));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(0);
    expect(result.visibleCount).toBe(1);
  });
});

describe('extractTables — errors', () => {
  it('throws ParserError DOCX_TABLE_XML_INVALID with cause for malformed XML', () => {
    let caught: unknown;
    try {
      extractTables('<not valid xml', EMPTY_STYLES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_TABLE_XML_INVALID');
    expect((caught as ParserError).cause).toBeDefined();
  });
});
