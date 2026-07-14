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
  cellHasContent,
  type HeaderFooterField,
  type HeaderFooterFieldContext,
  type HeaderFooterCell,
  type HeaderFooterRunChild,
} from './header-footer-fields.js';

// Minimal real PNG magic-byte signature (header only, no pixel data — the
// generator only ever needs the signature to sniff a type), matching
// header-footer-images.test.ts's fixtures.
const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
]).toString('base64');

const VALID_IMAGE_FIELD: HeaderFooterField = {
  kind: 'image',
  imageData: PNG_BASE64,
  widthEmu: 914400,
  heightEmu: 457200,
};

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
  'image',
];

const OTHER_KINDS: readonly HeaderFooterFieldKind[] = EXPECTED_KINDS.filter(
  (kind) => kind !== 'sectionNumber' && kind !== 'sectionTitle'
);

async function renderRunsToXml(runs: readonly HeaderFooterRunChild[]): Promise<string> {
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [...runs] })] }],
  });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

/** Every `<w:t>` run's text content, in document order. */
function textRunContents(xml: string): readonly string[] {
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1] ?? '');
}

describe('resolveFieldChildren — pageNumber invariant', () => {
  it('always resolves to a pageField token, never a literal numeric string, regardless of style, format, or source', () => {
    const variants: readonly HeaderFooterField[] = [
      { kind: 'pageNumber' },
      { kind: 'pageNumber', format: 'roman' },
      { kind: 'pageNumber', source: 'issuance' },
      { kind: 'pageNumber', source: 'current' },
      { kind: 'pageNumber', text: '3' },
    ];
    for (const field of variants) {
      const children = resolveFieldChildren(field, CTX);
      expect(children).toContainEqual({ kind: 'pageField', token: PageNumber.CURRENT });
      for (const value of children) {
        expect(value.kind === 'text' && /^\d+$/.test(value.text)).toBe(false);
      }
    }
  });

  it('label prefixes the field with literal text but still carries the field code', () => {
    expect(resolveFieldChildren({ kind: 'pageNumber', label: 'Page' }, CTX)).toEqual([
      { kind: 'text', text: 'Page' },
      { kind: 'pageField', token: PageNumber.CURRENT },
    ]);
  });

  it('renders as a real Word PAGE field instruction, not literal page-number text', async () => {
    const runs = renderFieldRun({ kind: 'pageNumber' }, CTX, undefined);
    const xml = await renderRunsToXml(runs);
    expect(xml).toMatch(/instrText[^>]*>PAGE</);
  });
});

describe('renderFieldRun — literal/value field text never collides with a docx field sentinel (#regression)', () => {
  // docx's own Run constructor pattern-matches any raw string passed through
  // `children` against these four PageNumber sentinel values and silently
  // swaps in a Word field code. A literal or resolved value field whose text
  // happens to equal one of them must still render as plain `<w:t>` text.
  const SENTINEL_STRINGS = ['CURRENT', 'TOTAL_PAGES', 'TOTAL_PAGES_IN_SECTION', 'SECTION'] as const;

  it.each(SENTINEL_STRINGS)(
    'a literal field with text %s renders as literal text',
    async (text) => {
      const runs = renderFieldRun({ kind: 'literal', text }, CTX, undefined);
      const xml = await renderRunsToXml(runs);
      expect(xml).not.toContain('instrText');
      expect(xml).not.toContain('fldChar');
      expect(textRunContents(xml)).toEqual([text]);
    }
  );

  it.each(SENTINEL_STRINGS)(
    'a value field resolving to %s renders as literal text',
    async (text) => {
      const ctx: HeaderFooterFieldContext = {
        ...CTX,
        current: { ...CTX.current, revisionLabel: text },
      };
      const runs = renderFieldRun({ kind: 'revisionLabel' }, ctx, undefined);
      const xml = await renderRunsToXml(runs);
      expect(xml).not.toContain('instrText');
      expect(xml).not.toContain('fldChar');
      expect(textRunContents(xml)).toEqual([text]);
    }
  );

  it('a pageNumber label equal to a sentinel string renders as literal text alongside exactly one real field code', async () => {
    const runs = renderFieldRun({ kind: 'pageNumber', label: 'SECTION' }, CTX, undefined);
    const xml = await renderRunsToXml(runs);
    expect((xml.match(/w:fldCharType="begin"/g) ?? []).length).toBe(1);
    expect(textRunContents(xml)).toEqual(['SECTION']);
  });
});

describe('resolveFieldChildren field-kind coverage', () => {
  it('the schema enum still has exactly the 13 kinds the resolver table covers', () => {
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
      { kind: 'text', text: CTX.sectionNumber },
    ]);
    expect(resolveFieldChildren({ kind: 'sectionTitle', text: 'WRONG TITLE' }, CTX)).toEqual([
      { kind: 'text', text: CTX.sectionTitle },
    ]);
  });

  it('every other kind ignores ctx.sectionNumber/ctx.sectionTitle', () => {
    for (const kind of OTHER_KINDS) {
      const children = resolveFieldChildren({ kind }, CTX);
      expect(children).not.toContainEqual({ kind: 'text', text: CTX.sectionNumber });
      expect(children).not.toContainEqual({ kind: 'text', text: CTX.sectionTitle });
    }
  });
});

describe('resolveFieldChildren — value fields (current/issuance)', () => {
  it('reads from ctx.current by default (no field.source)', () => {
    expect(resolveFieldChildren({ kind: 'projectName' }, CTX)).toEqual([
      { kind: 'text', text: 'Riverside HQ' },
    ]);
  });

  it('field.source: "issuance" reads ctx.issuance when present', () => {
    const withIssuance: HeaderFooterFieldContext = {
      ...CTX,
      issuance: { ...CTX.current, projectName: 'Riverside HQ (Issuance Snapshot)' },
    };
    expect(resolveFieldChildren({ kind: 'projectName', source: 'issuance' }, withIssuance)).toEqual(
      [{ kind: 'text', text: 'Riverside HQ (Issuance Snapshot)' }]
    );
  });

  it('field.source: "issuance" falls back to ctx.current when the key is absent from issuance', () => {
    const withIssuance: HeaderFooterFieldContext = { ...CTX, issuance: { date: '2026-08-01' } };
    expect(resolveFieldChildren({ kind: 'projectName', source: 'issuance' }, withIssuance)).toEqual(
      [{ kind: 'text', text: 'Riverside HQ' }]
    );
  });

  it('field.source: "issuance" falls back to ctx.current when ctx.issuance is undefined', () => {
    expect(resolveFieldChildren({ kind: 'projectName', source: 'issuance' }, CTX)).toEqual([
      { kind: 'text', text: 'Riverside HQ' },
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
      { kind: 'text', text: 'CONFIDENTIAL' },
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
    expect(children).toEqual([{ kind: 'text', text: 'DRAFT' }]);
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

describe('cellHasContent — resolved-output emptiness, not just content-array length', () => {
  it('is false for an undefined cell', () => {
    expect(cellHasContent(undefined, CTX)).toBe(false);
  });

  it('is false for a cell with an empty content array', () => {
    expect(cellHasContent({ content: [] }, CTX)).toBe(false);
  });

  it('is false when the only field resolves to no output (literal with no text)', () => {
    expect(cellHasContent({ content: [{ kind: 'literal' }] }, CTX)).toBe(false);
  });

  it('is false when a value field key is absent from ctx everywhere', () => {
    const empty: HeaderFooterFieldContext = { sectionNumber: '', sectionTitle: '', current: {} };
    expect(cellHasContent({ content: [{ kind: 'clientNumber' }] }, empty)).toBe(false);
  });

  it('is true when at least one field resolves to output', () => {
    expect(cellHasContent({ content: [{ kind: 'literal', text: 'x' }] }, CTX)).toBe(true);
  });

  it('is true when a mix of empty and non-empty fields is present', () => {
    const cell: HeaderFooterCell = {
      content: [{ kind: 'literal' }, { kind: 'literal', text: 'x' }],
    };
    expect(cellHasContent(cell, CTX)).toBe(true);
  });
});

describe('cellHasContent — image field OR-composition (#308)', () => {
  it('is true for an image-only cell carrying imageData', () => {
    expect(cellHasContent({ content: [VALID_IMAGE_FIELD] }, CTX)).toBe(true);
  });

  it('is false for an image-only cell with no imageData', () => {
    expect(cellHasContent({ content: [{ kind: 'image' }] }, CTX)).toBe(false);
  });

  it('is true for a cell mixing a resolving text field and an image field', () => {
    const cell: HeaderFooterCell = {
      content: [{ kind: 'literal', text: 'Logo:' }, VALID_IMAGE_FIELD],
    };
    expect(cellHasContent(cell, CTX)).toBe(true);
  });

  // Invariant (#308): cellHasContent becomes `resolveFieldChildren(...).length > 0
  // || imageFieldHasContent(...)` — an OR composition, not a rewrite. For every
  // non-image kind, imageFieldHasContent is always false, so the OR must reduce
  // to exactly the pre-existing resolveFieldChildren-based truth value.
  it('OR composition with the image branch never changes cellHasContent for the 12 pre-existing kinds', () => {
    const nonImageKinds = EXPECTED_KINDS.filter((kind) => kind !== 'image');
    for (const kind of nonImageKinds) {
      const field: HeaderFooterField = { kind };
      const expected = resolveFieldChildren(field, CTX).length > 0;
      expect(cellHasContent({ content: [field] }, CTX)).toBe(expected);
    }
  });

  // Invariant (#308): adding the 13th kind must never regress the other 12 —
  // a cell mixing every pre-existing kind with an image field still reports
  // content, and (more importantly) removing the image field from that same
  // mix does not change the outcome for the pre-existing fields' own truth.
  it('adding the image kind never regresses cellHasContent for the pre-existing kinds sharing its cell', () => {
    const literalOnly: HeaderFooterCell = { content: [{ kind: 'literal', text: 'x' }] };
    const literalPlusImage: HeaderFooterCell = {
      content: [{ kind: 'literal', text: 'x' }, { kind: 'image' }], // imageData absent
    };
    expect(cellHasContent(literalOnly, CTX)).toBe(cellHasContent(literalPlusImage, CTX));
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

  it('applies the cascaded cell style to the separator run, not just the fields (#regression)', async () => {
    const cell: HeaderFooterCell = {
      content: [
        { kind: 'literal', text: 'A' },
        { kind: 'literal', text: 'B' },
      ],
      separator: ' | ',
      style: { bold: true, italic: true, fontFamily: 'Arial' },
    };
    const runs = renderCellRuns(cell, CTX, undefined);
    expect(runs).toHaveLength(3);
    const xml = await renderRunsToXml(runs);
    // One property element per run — both field runs AND the separator between
    // them carry the cell's font/bold/italic, so a styled cell's divider isn't
    // left rendering in default formatting.
    expect((xml.match(/<w:b\/>/g) ?? []).length).toBe(3);
    expect((xml.match(/<w:i\/>/g) ?? []).length).toBe(3);
    expect((xml.match(/w:ascii="Arial"/g) ?? []).length).toBe(3);
  });
});

describe('renderCellRuns — image fields (#308)', () => {
  it('renders an image-only cell to exactly one run and no separator', () => {
    const cell: HeaderFooterCell = { content: [VALID_IMAGE_FIELD] };
    const runs = renderCellRuns(cell, CTX, undefined);
    expect(runs).toHaveLength(1);
  });

  it('interleaves the default separator between a literal and an image field', async () => {
    const cell: HeaderFooterCell = {
      content: [{ kind: 'literal', text: 'Logo:' }, VALID_IMAGE_FIELD],
    };
    const runs = renderCellRuns(cell, CTX, undefined);
    expect(runs).toHaveLength(3); // literal, separator, image
    const xml = await renderRunsToXml(runs);
    expect(xml).toContain('Logo:');
  });

  it('interleaves exactly two separators when an image field sits between two literals', () => {
    const cell: HeaderFooterCell = {
      content: [{ kind: 'literal', text: 'A' }, VALID_IMAGE_FIELD, { kind: 'literal', text: 'B' }],
    };
    const runs = renderCellRuns(cell, CTX, undefined);
    // literal A, separator, image, separator, literal B
    expect(runs).toHaveLength(5);
  });

  it('skips an unrenderable image field (missing dimensions) with no separator on either side (#regression)', async () => {
    const brokenImage: HeaderFooterField = { kind: 'image', imageData: PNG_BASE64 }; // no widthEmu/heightEmu
    const cell: HeaderFooterCell = {
      content: [{ kind: 'literal', text: 'A' }, brokenImage, { kind: 'literal', text: 'B' }],
    };
    const runs = renderCellRuns(cell, CTX, undefined);
    expect(runs).toHaveLength(3); // literal A, separator, literal B — image contributes nothing
    const xml = await renderRunsToXml(runs);
    expect(textRunContents(xml)).toEqual(['A', ' ', 'B']);
  });

  it('the cascaded cell style never applies to the image run itself (ImageRun carries no run-style options)', () => {
    const cell: HeaderFooterCell = { content: [VALID_IMAGE_FIELD], style: { bold: true } };
    const runs = renderCellRuns(cell, CTX, undefined);
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toBeInstanceOf(TextRun);
  });
});

describe('renderCellRuns — separator tracks resolved output, not content-array length (#regression)', () => {
  it('emits no separator when a leading field resolves to nothing', async () => {
    const cell: HeaderFooterCell = {
      content: [{ kind: 'literal' }, { kind: 'literal', text: 'B' }],
    };
    const runs = renderCellRuns(cell, CTX, undefined);
    expect(runs).toHaveLength(1);
    const xml = await renderRunsToXml(runs);
    expect(textRunContents(xml)).toEqual(['B']);
  });

  it('emits no separator when a trailing field resolves to nothing', async () => {
    const cell: HeaderFooterCell = {
      content: [{ kind: 'literal', text: 'A' }, { kind: 'literal' }],
    };
    const runs = renderCellRuns(cell, CTX, undefined);
    expect(runs).toHaveLength(1);
    const xml = await renderRunsToXml(runs);
    expect(textRunContents(xml)).toEqual(['A']);
  });

  it('emits exactly one separator between two resolving fields even with an empty field between them', async () => {
    const cell: HeaderFooterCell = {
      content: [
        { kind: 'literal', text: 'A' },
        { kind: 'literal' },
        { kind: 'literal', text: 'B' },
      ],
    };
    const runs = renderCellRuns(cell, CTX, undefined);
    const xml = await renderRunsToXml(runs);
    expect(textRunContents(xml)).toEqual(['A', ' ', 'B']);
  });
});
