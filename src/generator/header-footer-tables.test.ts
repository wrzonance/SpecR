import { describe, it, expect } from 'vitest';
import { Document, Header, Packer } from 'docx';
import JSZip from 'jszip';
import {
  buildTable,
  tableWarnings,
  type HeaderFooterTable,
  type HeaderFooterTableCell,
} from './header-footer-tables.js';
import type { HeaderFooterFieldContext, HeaderFooterVisualStyle } from './header-footer-fields.js';

const CTX: HeaderFooterFieldContext = {
  sectionNumber: '09 91 26',
  sectionTitle: 'EXTERIOR PAINTING',
  current: {},
};

// A minimal real PNG magic-byte signature (matches header-footer-images
// .test.ts's fixture) — enough for `renderImageRun`'s sniff step, never
// actually reached inside a table cell per this file's invariants.
const LOGO_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
]).toString('base64');

function literalCell(
  text: string,
  extra: Partial<HeaderFooterTableCell> = {}
): HeaderFooterTableCell {
  return { content: [{ kind: 'literal', text }], ...extra };
}

function imageCell(): HeaderFooterTableCell {
  return {
    content: [{ kind: 'image', imageData: LOGO_PNG_BASE64, widthEmu: 914400, heightEmu: 457200 }],
  };
}

function textTable(rows: readonly (readonly HeaderFooterTableCell[])[]): HeaderFooterTable {
  return { rows: rows.map((cells) => ({ cells: [...cells] })) };
}

/** Renders `table` inside a header part and returns `word/header1.xml`. */
async function renderTableToHeaderXml(
  table: NonNullable<ReturnType<typeof buildTable>>
): Promise<string> {
  const doc = new Document({
    sections: [{ headers: { default: new Header({ children: [table] }) }, children: [] }],
  });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const file = zip.file('word/header1.xml');
  if (!file) throw new Error('header1.xml missing');
  return file.async('string');
}

describe('buildTable', () => {
  it('is undefined for an undefined table', () => {
    expect(buildTable(undefined, undefined, CTX)).toBeUndefined();
  });

  it('is defined for a minimal one-row, one-cell table', () => {
    const table = textTable([[literalCell('A')]]);
    expect(buildTable(table, undefined, CTX)).toBeDefined();
  });
});

describe('buildTable — round-trip fidelity', () => {
  it('renders every row and cell, in order, as real text content', async () => {
    const table = textTable([
      [literalCell('Left'), literalCell('Right')],
      [literalCell('Bottom-left'), literalCell('Bottom-right')],
    ]);
    const built = buildTable(table, undefined, CTX);
    expect(built).toBeDefined();
    const xml = await renderTableToHeaderXml(built!);

    expect(xml).toContain('<w:tbl>');
    expect((xml.match(/<w:tr>/g) ?? []).length).toBe(2);
    expect((xml.match(/<w:tc>/g) ?? []).length).toBe(4);
    // Cell order in the XML must match row/cell authoring order.
    const leftIdx = xml.indexOf('>Left<');
    const rightIdx = xml.indexOf('>Right<');
    const bottomLeftIdx = xml.indexOf('>Bottom-left<');
    const bottomRightIdx = xml.indexOf('>Bottom-right<');
    expect(leftIdx).toBeGreaterThan(-1);
    expect(leftIdx).toBeLessThan(rightIdx);
    expect(rightIdx).toBeLessThan(bottomLeftIdx);
    expect(bottomLeftIdx).toBeLessThan(bottomRightIdx);
  });

  it('renders an empty cell as a contentless <w:tc><w:p/></w:tc>, never dropped', async () => {
    const table = textTable([[literalCell('A'), { content: [] }]]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect((xml.match(/<w:tc>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<w:tc><w:p/></w:tc>');
  });

  it('round-trips columnSpan as w:gridSpan', async () => {
    const table = textTable([[literalCell('Merged', { columnSpan: 2 })]]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
  });

  it('round-trips columnWidths as w:tblGrid/w:gridCol', async () => {
    const table: HeaderFooterTable = {
      rows: [{ cells: [literalCell('A'), literalCell('B')] }],
      columnWidths: [3000, 1500],
    };
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).toContain('<w:tblGrid>');
    expect(xml).toContain('<w:gridCol w:w="3000"/>');
    expect(xml).toContain('<w:gridCol w:w="1500"/>');
  });

  it('passes no columnWidths option through when table.columnWidths is absent', async () => {
    // docx's `Table` always synthesizes its OWN default `w:tblGrid` (one
    // `w:gridCol w:w="100"` per column) when the `columnWidths` option is
    // omitted entirely — this is docx's own unconditional behavior, not
    // something `buildTable` renders. The real invariant under test is that
    // `buildTable` never passes an option here: the emitted grid is exactly
    // docx's untouched 100-wide default, never the 3000/1500 widths the
    // "round-trips columnWidths" case above pins when they ARE declared.
    const table = textTable([[literalCell('A')]]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).toContain('<w:gridCol w:w="100"/>');
    expect(xml).not.toContain('w:w="3000"');
  });

  it('separates multiple fields in one cell with the default single-space separator', async () => {
    const table = textTable([
      [
        {
          content: [
            { kind: 'literal', text: 'A' },
            { kind: 'literal', text: 'B' },
          ],
        },
      ],
    ]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).toContain('>A<');
    expect(xml).toContain('>B<');
    // The separator run's own <w:t> carries the single space between A and B.
    expect(xml).toMatch(/<w:t xml:space="preserve"> <\/w:t>/);
  });

  it('honors a custom separator and an empty separator', async () => {
    const table = textTable([
      [
        {
          content: [
            { kind: 'literal', text: 'A' },
            { kind: 'literal', text: 'B' },
          ],
          separator: ' | ',
        },
      ],
    ]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).toContain('>A<');
    expect(xml).toContain('> | <');
  });
});

describe('buildTable — borders (ADR-071 decision 2: one rule line, all six edges)', () => {
  // A captured borderless table (borders absent, or a rule line not explicitly
  // `enabled: true`) MUST render no visible borders. docx's own `Table` injects
  // a default single/auto/sz=4 grid on every edge when the `borders` option is
  // OMITTED (verified against real Packer output), which would silently turn a
  // borderless source table into a bordered one — a round-trip fidelity break.
  // buildTable therefore ALWAYS emits an explicit `w:tblBorders`: all six edges
  // set to `w:val="none"` here to suppress docx's default. The 336699/double
  // styling below is what an explicitly enabled rule line pins.
  const NONE_EDGES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];

  it('renders all six edges as w:val="none" when table.borders is absent (suppresses docx default)', async () => {
    const table = textTable([[literalCell('A')]]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    const bordersMatch = /<w:tblBorders>([\s\S]*?)<\/w:tblBorders>/.exec(xml);
    expect(bordersMatch).not.toBeNull();
    const bordersXml = bordersMatch![1]!;
    expect(bordersXml).not.toMatch(/w:val="single"/);
    for (const edge of NONE_EDGES) {
      const edgeMatch = new RegExp(`<w:${edge}[^/]*/>`).exec(bordersXml);
      expect(edgeMatch, `expected a <w:${edge}/> border edge`).not.toBeNull();
      expect(edgeMatch![0]).toContain('w:val="none"');
    }
  });

  it('renders all six edges as w:val="none" when table.borders.enabled is not exactly true', async () => {
    const table: HeaderFooterTable = {
      rows: [{ cells: [literalCell('A')] }],
      borders: { enabled: false, widthTwips: 8, color: '336699' },
    };
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    const bordersMatch = /<w:tblBorders>([\s\S]*?)<\/w:tblBorders>/.exec(xml);
    expect(bordersMatch).not.toBeNull();
    const bordersXml = bordersMatch![1]!;
    expect(bordersXml).not.toContain('336699');
    expect(bordersXml).not.toMatch(/w:val="single"/);
    for (const edge of NONE_EDGES) {
      const edgeMatch = new RegExp(`<w:${edge}[^/]*/>`).exec(bordersXml);
      expect(edgeMatch, `expected a <w:${edge}/> border edge`).not.toBeNull();
      expect(edgeMatch![0]).toContain('w:val="none"');
    }
  });

  it('applies one enabled rule line uniformly to all six ITableBordersOptions edges', async () => {
    const table: HeaderFooterTable = {
      rows: [{ cells: [literalCell('A')] }],
      borders: { enabled: true, widthTwips: 8, color: '336699', style: 'double' },
    };
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    const bordersMatch = /<w:tblBorders>([\s\S]*?)<\/w:tblBorders>/.exec(xml);
    expect(bordersMatch).not.toBeNull();
    const bordersXml = bordersMatch![1]!;
    for (const edge of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
      const edgeMatch = new RegExp(`<w:${edge}[^/]*/>`).exec(bordersXml);
      expect(edgeMatch, `expected a <w:${edge}/> border edge`).not.toBeNull();
      expect(edgeMatch![0]).toContain('w:val="double"');
      expect(edgeMatch![0]).toContain('w:color="336699"');
    }
  });
});

describe('buildTable — style cascade (inheritedStyle passes straight through, no re-cascade)', () => {
  it('applies inheritedStyle to cell text when the cell/table set no style of their own', async () => {
    const style: HeaderFooterVisualStyle = { bold: true, fontFamily: 'Arial' };
    const table = textTable([[literalCell('Styled')]]);
    const built = buildTable(table, style, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).toMatch(/<w:b\/>/);
    expect(xml).toContain('w:ascii="Arial"');
  });

  it('lets a cell-level style override the inherited style (most-specific-wins)', async () => {
    const style: HeaderFooterVisualStyle = { bold: true };
    const table = textTable([[literalCell('Styled', { style: { bold: false, italic: true } })]]);
    const built = buildTable(table, style, CTX);
    const xml = await renderTableToHeaderXml(built!);
    // cascadeStyle(cell.style, inheritedStyle) — bold: false from the cell wins.
    expect(xml).not.toMatch(/<w:b\/>/);
    expect(xml).toMatch(/<w:i\/>/);
  });
});

describe('buildTable — images never render inside table cells (ADR-071 decision 4)', () => {
  it('renders no w:drawing for a cell whose only content is an image field', async () => {
    const table = textTable([[imageCell()]]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).not.toContain('<w:drawing');
    expect(xml).not.toContain('<pic:pic');
  });

  it('renders the cell as an empty paragraph when its only field is an image', async () => {
    const table = textTable([[imageCell()]]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).toContain('<w:tc><w:p/></w:tc>');
  });

  it('renders the text sibling but never the image in a mixed-content cell', async () => {
    const table = textTable([
      [
        {
          content: [
            { kind: 'literal', text: 'Logo:' },
            { kind: 'image', imageData: LOGO_PNG_BASE64, widthEmu: 914400, heightEmu: 457200 },
          ],
        },
      ],
    ]);
    const built = buildTable(table, undefined, CTX);
    const xml = await renderTableToHeaderXml(built!);
    expect(xml).toContain('>Logo:<');
    expect(xml).not.toContain('<w:drawing');
  });
});

describe('tableWarnings', () => {
  it('returns [] for an undefined table', () => {
    expect(tableWarnings(undefined, 'header')).toEqual([]);
  });

  it('returns [] for a table with no image fields', () => {
    const table = textTable([[literalCell('A'), literalCell('B')]]);
    expect(tableWarnings(table, 'header')).toEqual([]);
  });

  it('warns once per image field, prefixed with location and the row/cell path', () => {
    const table = textTable([[literalCell('A'), imageCell()]]);
    const warnings = tableWarnings(table, 'header');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('header.table.row[0].cell[1]');
    expect(warnings[0]).toContain('image fields are not rendered inside table cells');
  });

  it('does not warn for an image field with no imageData (nothing would have rendered anyway)', () => {
    const table = textTable([[{ content: [{ kind: 'image' }] }]]);
    expect(tableWarnings(table, 'header')).toEqual([]);
  });

  it('accumulates one warning per image field across multiple rows/cells', () => {
    const table = textTable([
      [imageCell(), literalCell('A')],
      [literalCell('B'), imageCell()],
    ]);
    const warnings = tableWarnings(table, 'footer');
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('row[0].cell[0]'))).toBe(true);
    expect(warnings.some((w) => w.includes('row[1].cell[1]'))).toBe(true);
  });
});
