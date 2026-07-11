import { describe, it, expect } from 'vitest';
import { Document, Packer, Paragraph, PageNumber, TextRun } from 'docx';
import JSZip from 'jszip';
import { HeaderFooterFieldKindSchema } from '../ast/index.js';
import type { HeaderFooterFieldKind } from '../ast/index.js';
import {
  resolveFieldChildren,
  renderFieldRun,
  renderCellRuns,
  headerFooterRunOptions,
  cascadeStyle,
  cellIsEmpty,
  type HeaderFooterField,
  type HeaderFooterFieldContext,
  type HeaderFooterCell,
} from './header-footer-fields.js';

const CTX: HeaderFooterFieldContext = {
  sectionNumber: '09 91 26',
  sectionTitle: 'EXTERIOR PAINTING',
  current: {
    date: '2026-07-11',
    packageName: 'Bid Package 1',
    revisionName: 'Rev A',
    revisionLabel: 'A',
    projectName: 'Riverside HQ',
    projectNumber: '24-1001',
    clientName: 'Acme Corp',
    clientNumber: 'AC-01',
  },
};

const EXPECTED_KINDS: readonly HeaderFooterFieldKind[] = [
  'date',
  'sectionTitle',
  'sectionNumber',
  'pageNumber',
  'packageName',
  'revisionName',
  'revisionLabel',
  'projectName',
  'projectNumber',
  'clientName',
  'clientNumber',
  'literal',
];

const OTHER_KINDS: readonly HeaderFooterFieldKind[] = EXPECTED_KINDS.filter(
  (kind) => kind !== 'sectionNumber' && kind !== 'sectionTitle'
);

async function renderRunsToXml(runs: readonly TextRun[]): Promise<string> {
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [...runs] })] }],
  });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

describe('resolveFieldChildren — pageNumber invariant', () => {
  it('always resolves to PageNumber.CURRENT, never a literal numeric string, regardless of style, format, or source', () => {
    const variants: readonly HeaderFooterField[] = [
      { kind: 'pageNumber' },
      { kind: 'pageNumber', format: 'roman' },
      { kind: 'pageNumber', source: 'issuance' },
      { kind: 'pageNumber', source: 'current' },
      { kind: 'pageNumber', text: '3' },
    ];
    for (const field of variants) {
      const children = resolveFieldChildren(field, CTX);
      expect(children).toContain(PageNumber.CURRENT);
      for (const value of children) {
        expect(typeof value === 'string' && /^\d+$/.test(value)).toBe(false);
      }
    }
  });

  it('label prefixes the field with literal text but still carries the field code', () => {
    expect(resolveFieldChildren({ kind: 'pageNumber', label: 'Page' }, CTX)).toEqual([
      'Page',
      PageNumber.CURRENT,
    ]);
  });

  it('renders as a real Word PAGE field instruction, not literal page-number text', async () => {
    const run = renderFieldRun({ kind: 'pageNumber' }, CTX, undefined);
    const xml = await renderRunsToXml([run]);
    expect(xml).toMatch(/instrText[^>]*>PAGE</);
  });
});

describe('resolveFieldChildren field-kind coverage', () => {
  it('the schema enum still has exactly the 12 kinds the resolver table covers', () => {
    expect([...HeaderFooterFieldKindSchema.options].sort((a, b) => a.localeCompare(b))).toEqual(
      [...EXPECTED_KINDS].sort((a, b) => a.localeCompare(b))
    );
  });

  it('has exactly one resolver for every HeaderFooterFieldKind — none throw or fall through unresolved', () => {
    for (const kind of HeaderFooterFieldKindSchema.options) {
      expect(() => resolveFieldChildren({ kind }, CTX)).not.toThrow();
    }
  });
});

describe('resolveFieldChildren — sectionNumber/sectionTitle source isolation', () => {
  it('sectionNumber and sectionTitle read only ctx, never field.text', () => {
    expect(resolveFieldChildren({ kind: 'sectionNumber', text: '00 00 00' }, CTX)).toEqual([
      CTX.sectionNumber,
    ]);
    expect(resolveFieldChildren({ kind: 'sectionTitle', text: 'WRONG TITLE' }, CTX)).toEqual([
      CTX.sectionTitle,
    ]);
  });

  it('every other kind ignores ctx.sectionNumber/ctx.sectionTitle', () => {
    for (const kind of OTHER_KINDS) {
      const children = resolveFieldChildren({ kind }, CTX);
      expect(children).not.toContain(CTX.sectionNumber);
      expect(children).not.toContain(CTX.sectionTitle);
    }
  });
});

describe('resolveFieldChildren — value fields (current/issuance)', () => {
  it('reads from ctx.current by default (no field.source)', () => {
    expect(resolveFieldChildren({ kind: 'projectName' }, CTX)).toEqual(['Riverside HQ']);
  });

  it('field.source: "issuance" reads ctx.issuance when present', () => {
    const withIssuance: HeaderFooterFieldContext = {
      ...CTX,
      issuance: { ...CTX.current, projectName: 'Riverside HQ (Issuance Snapshot)' },
    };
    expect(resolveFieldChildren({ kind: 'projectName', source: 'issuance' }, withIssuance)).toEqual(
      ['Riverside HQ (Issuance Snapshot)']
    );
  });

  it('field.source: "issuance" falls back to ctx.current when the key is absent from issuance', () => {
    const withIssuance: HeaderFooterFieldContext = { ...CTX, issuance: { date: '2026-08-01' } };
    expect(resolveFieldChildren({ kind: 'projectName', source: 'issuance' }, withIssuance)).toEqual(
      ['Riverside HQ']
    );
  });

  it('field.source: "issuance" falls back to ctx.current when ctx.issuance is undefined', () => {
    expect(resolveFieldChildren({ kind: 'projectName', source: 'issuance' }, CTX)).toEqual([
      'Riverside HQ',
    ]);
  });

  it('resolves to [] when the requested key is absent everywhere', () => {
    const empty: HeaderFooterFieldContext = { sectionNumber: '', sectionTitle: '', current: {} };
    expect(resolveFieldChildren({ kind: 'clientNumber' }, empty)).toEqual([]);
  });
});

describe('resolveFieldChildren — literal', () => {
  it('passes field.text through verbatim', () => {
    expect(resolveFieldChildren({ kind: 'literal', text: 'CONFIDENTIAL' }, CTX)).toEqual([
      'CONFIDENTIAL',
    ]);
  });

  it('resolves to [] when field.text is absent', () => {
    expect(resolveFieldChildren({ kind: 'literal' }, CTX)).toEqual([]);
  });
});

describe('resolveFieldChildren — deferred field knobs (#303 scope)', () => {
  it('field.format/prefix/suffix are schema-valid but not applied by any resolver in this pass', () => {
    const children = resolveFieldChildren(
      { kind: 'literal', text: 'DRAFT', format: 'upper', prefix: '[', suffix: ']' },
      CTX
    );
    expect(children).toEqual(['DRAFT']);
  });
});

describe('cellIsEmpty', () => {
  it('is true for an undefined cell', () => {
    expect(cellIsEmpty(undefined)).toBe(true);
  });

  it('is true for a cell with no content field', () => {
    expect(cellIsEmpty({})).toBe(true);
  });

  it('is true for a cell with an empty content array', () => {
    expect(cellIsEmpty({ content: [] })).toBe(true);
  });

  it('is false for a cell with at least one field', () => {
    expect(cellIsEmpty({ content: [{ kind: 'literal', text: 'x' }] })).toBe(false);
  });
});

describe('headerFooterRunOptions', () => {
  it('returns {} for undefined style', () => {
    expect(headerFooterRunOptions(undefined)).toEqual({});
  });

  it('maps fontFamily, fontSizeHalfPt, bold, italic, caps, color', () => {
    expect(
      headerFooterRunOptions({
        fontFamily: 'Arial',
        fontSizeHalfPt: 18,
        bold: true,
        italic: true,
        caps: true,
        color: '000000',
      })
    ).toEqual({
      font: 'Arial',
      size: 18,
      bold: true,
      italics: true,
      allCaps: true,
      color: '000000',
    });
  });

  it('omits keys absent from the payload (exactOptionalPropertyTypes-safe)', () => {
    expect(headerFooterRunOptions({ bold: true })).toEqual({ bold: true });
  });
});

describe('cascadeStyle', () => {
  it('returns undefined for no layers', () => {
    expect(cascadeStyle()).toBeUndefined();
  });

  it('returns undefined when every layer is undefined', () => {
    expect(cascadeStyle(undefined, undefined)).toBeUndefined();
  });

  it('returns the single defined layer unchanged', () => {
    expect(cascadeStyle(undefined, { bold: true })).toEqual({ bold: true });
  });

  it('the earlier (more specific) argument wins on key conflicts', () => {
    expect(cascadeStyle({ bold: true }, { bold: false, italic: true })).toEqual({
      bold: true,
      italic: true,
    });
  });

  it('shallow-merges distinct keys across three layers, most-specific first', () => {
    expect(cascadeStyle({ color: 'ff0000' }, { bold: true }, { fontFamily: 'Arial' })).toEqual({
      color: 'ff0000',
      bold: true,
      fontFamily: 'Arial',
    });
  });
});

describe('renderCellRuns', () => {
  it('returns [] for an absent cell', () => {
    expect(renderCellRuns(undefined, CTX, undefined)).toEqual([]);
  });

  it('returns [] for a cell with empty content', () => {
    expect(renderCellRuns({ content: [] }, CTX, undefined)).toEqual([]);
  });

  it('emits exactly one run and no separator for a single-field cell', () => {
    const cell: HeaderFooterCell = { content: [{ kind: 'literal', text: 'Confidential' }] };
    expect(renderCellRuns(cell, CTX, undefined)).toHaveLength(1);
  });

  it('interleaves the default separator between 2+ fields', async () => {
    const cell: HeaderFooterCell = {
      content: [
        { kind: 'literal', text: 'A' },
        { kind: 'literal', text: 'B' },
      ],
    };
    const runs = renderCellRuns(cell, CTX, undefined);
    expect(runs).toHaveLength(3);
    const xml = await renderRunsToXml(runs);
    expect(xml).toContain('A');
    expect(xml).toContain('B');
  });

  it('uses cell.separator when set, and cascades cell.style over inheritedStyle', async () => {
    const cell: HeaderFooterCell = {
      content: [
        { kind: 'literal', text: 'A' },
        { kind: 'literal', text: 'B' },
      ],
      separator: ' | ',
      style: { bold: true },
    };
    const runs = renderCellRuns(cell, CTX, { fontFamily: 'Arial' });
    const xml = await renderRunsToXml(runs);
    expect(xml).toContain(' | ');
    expect(xml).toMatch(/<w:b\/>/);
  });
});
