import { describe, it, expect } from 'vitest';
import { extractTables, classifyTopLevelTables } from './tables.js';
import type { ClassifiedTopLevelTable } from './tables.js';
import { buildStyleMap } from './styles.js';
import { ParserError } from '../error.js';
import type { StyleMap } from './types.js';

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

  // INV-4 cross-row: 'any single visible-text paragraph anywhere in the table
  // forces the whole table visible' must hold across rows, not just within one
  // row. Places the vanish evidence in row 1 and the visible evidence in row 2
  // of the same table — a per-row classifier that decided row-by-row could
  // still pass the same-row 'mixed' test above while misclassifying this case.
  it('classifies a table visible when the visible evidence is in a different row than the vanish evidence', () => {
    const xml = makeDocXml(
      table(row(cell(vanishPara('hidden row'))) + row(cell(visiblePara('shown row'))))
    );
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

  // Regression (Codex #293): a hidden cell whose run lives inside a w:sdt content control
  // — the wrapper SpecR's OWN generator emits as round-trip merge anchors — must be
  // retained, not dropped. isParagraphVanish already recurses through w:sdt (via
  // collectRuns), but the old direct+hyperlink text reader returned '' for it, so
  // classifyTable saw no text-bearing evidence and misclassified the fully-hidden table
  // as visible: the hidden content was silently discarded (never retained, no warning of
  // loss). extractParagraphText now walks the same wrappers, keeping text and hiddenness
  // symmetric so the table is both classified hidden AND retained with its real text.
  it('retains a hidden table whose cell text is inside a w:sdt content control (not dropped as visible)', () => {
    const sdtVanish = `<w:p><w:sdt><w:sdtContent><w:r><w:rPr><w:vanish/></w:rPr><w:t>sdt secret</w:t></w:r></w:sdtContent></w:sdt></w:p>`;
    const xml = makeDocXml(table(row(cell(sdtVanish))));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([['sdt secret']]);
    expect(result.visibleCount).toBe(0);
  });

  // Same asymmetry via a w:ins tracked-change wrapper (owner/editor redlines are a core
  // SpecR use case, so a redlined hidden table cell is realistic, not contrived).
  it('retains a hidden table whose cell text is inside a w:ins tracked-change wrapper', () => {
    const insVanish = `<w:p><w:ins><w:r><w:rPr><w:vanish/></w:rPr><w:t>inserted secret</w:t></w:r></w:ins></w:p>`;
    const xml = makeDocXml(table(row(cell(insVanish))));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([['inserted secret']]);
    expect(result.visibleCount).toBe(0);
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

  // Regression: classifyTable's evidence filter must trim before checking for real
  // content, matching the convention used elsewhere for the same "does this paragraph
  // carry real content" check (inference.ts, lead-in-nesting.ts). A whitespace-only
  // non-vanish paragraph (a common Word spacer/padding run, e.g. a row-height filler
  // cell) is not real visible evidence — it must not force a table whose only actual
  // content is vanish into the 'visible' classification, which would silently and
  // irretrievably drop genuinely hidden content instead of retaining it (ADR-038).
  it('classifies hidden when the only non-vanish paragraph is whitespace-only — not forced visible by a spacer cell', () => {
    const secretCell = cell(vanishPara('TOP SECRET'));
    const whitespaceSpacerCell = cell(`<w:p><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>`);
    const xml = makeDocXml(table(row(secretCell + whitespaceSpacerCell)));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([['TOP SECRET', '']]);
    expect(result.visibleCount).toBe(0);
  });

  // INV-2: cell text is a lossless join of its paragraphs — every paragraph's text
  // is preserved, in document order, separated by '\n', with only the outer
  // leading/trailing whitespace trimmed. A regression to the separator, the paragraph
  // order, a dropped paragraph, or the outer .trim() must fail this test.
  it('INV-2: joins a multi-paragraph cell with newline separators, preserving order and dropping only outer whitespace', () => {
    const multiParaCell = cell(
      vanishPara('') + vanishPara('line one') + vanishPara('line two') + vanishPara('')
    );
    const soloCell = cell(vanishPara('third'));
    const xml = makeDocXml(table(row(multiParaCell + soloCell)));
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(1);
    expect(result.hiddenTables[0]?.rows).toEqual([['line one\nline two', 'third']]);
  });

  // INV-7 (counting): visibleCount reflects the true total of visible tables, not
  // capped at 1. A regression that stops incrementing past the first visible table
  // (or double-counts a duplicated w:tbl match) must fail this test.
  it('counts every visible table when more than one is present — visibleCount is not capped at 1', () => {
    const visibleA = table(row(cell(visiblePara('a'))));
    const visibleB = table(row(cell(visiblePara('b'))));
    const visibleC = table(row(cell(visiblePara('c'))));
    const xml = makeDocXml(visibleA + visibleB + visibleC);
    const result = extractTables(xml, EMPTY_STYLES);
    expect(result.hiddenTables).toHaveLength(0);
    expect(result.visibleCount).toBe(3);
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

// extractTables' reduction over classifyTopLevelTables — mirrors the composition
// extractTables itself performs, so the regression tests below can assert
// extractTables(xml, styleMap) is byte-identical to deriving it from the promoted
// classifyTopLevelTables export, not just independently correct.
function deriveExtractionResult(classifications: readonly ClassifiedTopLevelTable[]) {
  return {
    hiddenTables: classifications.flatMap((c) => (c.kind === 'hidden' ? [c.table] : [])),
    visibleCount: classifications.filter((c) => c.kind === 'visible').length,
  };
}

describe('classifyTopLevelTables — promoted extraction (zero-behavior-change)', () => {
  it('returns one classification per top-level table, hidden with its retained table', () => {
    const xml = makeDocXml(table(row(cell(vanishPara('secret A')) + cell(vanishPara('secret B')))));
    const result = classifyTopLevelTables(xml, EMPTY_STYLES);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: 'hidden',
      table: { rows: [['secret A', 'secret B']] },
    });
  });

  it('returns a visible classification (no table payload) when no cell paragraph is vanish', () => {
    const xml = makeDocXml(table(row(cell(visiblePara('a')) + cell(visiblePara('b')))));
    const result = classifyTopLevelTables(xml, EMPTY_STYLES);
    expect(result).toEqual([{ kind: 'visible' }]);
  });

  it('classifies multiple top-level tables independently, in document order', () => {
    const hidden = table(row(cell(vanishPara('secret'))));
    const visible = table(row(cell(visiblePara('shown'))));
    const xml = makeDocXml(hidden + visible);
    const result = classifyTopLevelTables(xml, EMPTY_STYLES);
    expect(result).toEqual([
      { kind: 'hidden', table: { rows: [['secret']] } },
      { kind: 'visible' },
    ]);
  });

  it('returns an empty array when word/document.xml has no w:tbl', () => {
    const xml = makeDocXml(visiblePara('no tables here'));
    expect(classifyTopLevelTables(xml, EMPTY_STYLES)).toEqual([]);
  });

  it('throws ParserError DOCX_TABLE_XML_INVALID with cause for malformed XML (same error as extractTables)', () => {
    let caught: unknown;
    try {
      classifyTopLevelTables('<not valid xml', EMPTY_STYLES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_TABLE_XML_INVALID');
    expect((caught as ParserError).cause).toBeDefined();
  });
});

describe('extractTables — composes byte-identically over classifyTopLevelTables', () => {
  const fixtures: Record<string, { xml: string; styleMap?: StyleMap }> = {
    'single hidden table': {
      xml: makeDocXml(table(row(cell(vanishPara('secret A')) + cell(vanishPara('secret B'))))),
    },
    'single visible table': {
      xml: makeDocXml(table(row(cell(visiblePara('a')) + cell(visiblePara('b'))))),
    },
    'mixed cells within one row (visible)': {
      xml: makeDocXml(table(row(cell(vanishPara('hidden')) + cell(visiblePara('shown'))))),
    },
    'vanish and visible evidence split across rows (visible)': {
      xml: makeDocXml(
        table(row(cell(vanishPara('hidden row'))) + row(cell(visiblePara('shown row'))))
      ),
    },
    'empty table — no evidence (visible)': {
      xml: makeDocXml(table(row(cell('<w:p/>') + cell('<w:p/>')))),
    },
    'no tables in the document': {
      xml: makeDocXml(visiblePara('no tables here')),
    },
    'three independent visible tables': {
      xml: makeDocXml(
        table(row(cell(visiblePara('a')))) +
          table(row(cell(visiblePara('b')))) +
          table(row(cell(visiblePara('c'))))
      ),
    },
    'a row with zero w:tc preserved as an empty array': {
      xml: makeDocXml(table(row('') + row(cell(vanishPara('only row with content'))))),
    },
    'nested table inside a cell (KNOWN AMBIGUITY, not discovered)': {
      xml: makeDocXml(
        table(
          row(cell(visiblePara('outer visible') + table(row(cell(vanishPara('nested secret'))))))
        )
      ),
    },
  };

  it.each(Object.entries(fixtures))(
    'extractTables(%s) equals deriveExtractionResult(classifyTopLevelTables(...))',
    (_name, { xml, styleMap }) => {
      const styles = styleMap ?? EMPTY_STYLES;
      const direct = extractTables(xml, styles);
      const derived = deriveExtractionResult(classifyTopLevelTables(xml, styles));
      expect(direct).toEqual(derived);
    }
  );
});
