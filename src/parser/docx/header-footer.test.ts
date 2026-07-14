import { describe, it, expect } from 'vitest';
import { captureHeaderFooter } from './header-footer.js';
import type { HeaderFooterCaptureEntries } from './header-footer.js';

const KNOWN = { section: '09 91 26', title: 'STAINING AND TRANSPARENT FINISHING' };

function makeDocXml(sectPr: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Body paragraph.</w:t></w:r></w:p>
    ${sectPr}
  </w:body>
</w:document>`;
}

function headerRef(rId: string, type: string): string {
  return `<w:headerReference w:type="${type}" r:id="${rId}"/>`;
}

function footerRef(rId: string, type: string): string {
  return `<w:footerReference w:type="${type}" r:id="${rId}"/>`;
}

function makeRelsXml(relationships: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function relationship(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${target}"/>`;
}

function makeSettingsXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:settings>`;
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function makeHdrXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:hdr>`;
}

function makeFtrXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:ftr>`;
}

function baseEntries(
  overrides: Partial<HeaderFooterCaptureEntries> = {}
): HeaderFooterCaptureEntries {
  return {
    documentXml: makeDocXml(''),
    settingsXml: null,
    documentRelsXml: null,
    headerParts: new Map(),
    footerParts: new Map(),
    ...overrides,
  };
}

describe('captureHeaderFooter — no header/footer content', () => {
  it('returns undefined composition and no warnings for a document with no sectPr at all', () => {
    const result = captureHeaderFooter(baseEntries(), KNOWN);
    expect(result.composition).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('returns undefined composition for an empty w:sectPr with no references', () => {
    const result = captureHeaderFooter(
      baseEntries({ documentXml: makeDocXml('<w:sectPr/>') }),
      KNOWN
    );
    expect(result.composition).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

describe('captureHeaderFooter — default variant capture', () => {
  it('captures a default header/footer into variants.default when references resolve', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}${footerRef('rId2', 'default')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(
          relationship('rId1', 'header1.xml') + relationship('rId2', 'footer1.xml')
        ),
        headerParts: new Map([['word/header1.xml', makeHdrXml('09 91 26')]]),
        footerParts: new Map([['word/footer1.xml', makeFtrXml('Confidential')]]),
      }),
      KNOWN
    );
    expect(result.composition).toMatchObject({
      variants: {
        default: {
          header: { left: { content: [{ kind: 'sectionNumber' }] } },
          footer: { left: { content: [{ kind: 'literal', text: 'Confidential' }] } },
        },
      },
    });
    expect(result.composition?.variants?.first).toBeUndefined();
    expect(result.composition?.variants?.even).toBeUndefined();
    expect(result.composition?.raw).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

// INVARIANT: variants.first is populated only when sectionInfo.titlePg is
// true; variants.even only when settings.evenAndOddHeaders is true. A
// reference that resolves to a real relationship target but whose toggle is
// off is never promoted into an active variant — it surfaces as
// raw.unmodeled { kind: 'inactiveVariant' } plus a warning instead.
describe('captureHeaderFooter — first/even variant gating (ADR-068)', () => {
  it('populates variants.first when w:titlePg is present', () => {
    const sectPr = `<w:sectPr><w:titlePg/>${headerRef('rId1', 'first')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
        headerParts: new Map([['word/header1.xml', makeHdrXml('First Page')]]),
      }),
      KNOWN
    );
    expect(result.composition?.variants?.first?.header?.left?.content).toEqual([
      { kind: 'literal', text: 'First Page' },
    ]);
    expect(result.composition?.raw).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('does NOT populate variants.first when w:titlePg is absent, and captures raw.unmodeled { kind: inactiveVariant } instead', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'first')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
        headerParts: new Map([['word/header1.xml', makeHdrXml('First Page')]]),
      }),
      KNOWN
    );
    expect(result.composition?.variants?.first).toBeUndefined();
    expect(result.composition?.raw?.unmodeled).toEqual([
      expect.objectContaining({ variant: 'first', region: 'header', kind: 'inactiveVariant' }),
    ]);
    expect(result.composition?.raw?.warnings).toHaveLength(1);
  });

  it('populates variants.even when w:evenAndOddHeaders is present in settings.xml', () => {
    const sectPr = `<w:sectPr>${footerRef('rId1', 'even')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        settingsXml: makeSettingsXml('<w:evenAndOddHeaders/>'),
        documentRelsXml: makeRelsXml(relationship('rId1', 'footer1.xml')),
        footerParts: new Map([['word/footer1.xml', makeFtrXml('Even Page')]]),
      }),
      KNOWN
    );
    expect(result.composition?.variants?.even?.footer?.left?.content).toEqual([
      { kind: 'literal', text: 'Even Page' },
    ]);
  });

  it('does NOT populate variants.even when w:evenAndOddHeaders is absent, and captures raw.unmodeled { kind: inactiveVariant } instead', () => {
    const sectPr = `<w:sectPr>${footerRef('rId1', 'even')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(relationship('rId1', 'footer1.xml')),
        footerParts: new Map([['word/footer1.xml', makeFtrXml('Even Page')]]),
      }),
      KNOWN
    );
    expect(result.composition?.variants?.even).toBeUndefined();
    expect(result.composition?.raw?.unmodeled).toEqual([
      expect.objectContaining({ variant: 'even', region: 'footer', kind: 'inactiveVariant' }),
    ]);
  });

  it('the default variant is always active regardless of titlePg/evenAndOddHeaders', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
        headerParts: new Map([['word/header1.xml', makeHdrXml('Default')]]),
      }),
      KNOWN
    );
    expect(result.composition?.variants?.default?.header?.left?.content).toEqual([
      { kind: 'literal', text: 'Default' },
    ]);
  });
});

// INVARIANT: exactly one aggregate ParseWarning { type:
// 'header-footer-content-skipped' } is emitted at the tree level iff
// raw.warnings is non-empty — never zero-when-content-was-dropped, never
// one-per-item at the tree level.
describe('captureHeaderFooter — aggregate tree-level warning (ADR-068)', () => {
  it('emits no tree-level warning when nothing was unmodeled', () => {
    const result = captureHeaderFooter(baseEntries(), KNOWN);
    expect(result.warnings).toEqual([]);
  });

  it('emits exactly ONE aggregate warning when multiple items are unmodeled, not one per item', () => {
    // Two independent unmodeled sources: an unresolved reference (rId2 has no
    // relationship) and an inactive first-page reference (titlePg absent).
    const sectPr = `<w:sectPr>${headerRef('rId1', 'first')}${footerRef('rId2', 'default')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
        headerParts: new Map([['word/header1.xml', makeHdrXml('First Page')]]),
      }),
      KNOWN
    );
    expect(result.composition?.raw?.unmodeled?.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ type: 'header-footer-content-skipped' });
  });

  it('flags hasAdditionalSectionBreaks with its own raw.warnings entry, folded into the same single aggregate warning', () => {
    const midBreak = `<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>break</w:t></w:r></w:p>`;
    const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Body paragraph.</w:t></w:r></w:p>
    ${midBreak}
    <w:sectPr/>
  </w:body>
</w:document>`;
    const result = captureHeaderFooter(baseEntries({ documentXml: docXml }), KNOWN);
    expect(result.composition?.raw?.warnings).toEqual([
      expect.stringContaining('additional section breaks'),
    ]);
    expect(result.warnings).toHaveLength(1);
  });
});

// INVARIANT: captureHeaderFooter never throws for document-content reasons.
// Only malformed-but-present XML (surfaced upstream by
// parseSectionHeaderFooterInfo/parseDocumentSettings/parseDocumentRelationships)
// throws — an unusual-but-valid document shape never does.
describe('captureHeaderFooter — never throws for document-content reasons', () => {
  it('does not throw for an unresolved reference (rId with no matching relationship)', () => {
    const sectPr = `<w:sectPr>${headerRef('rIdMissing', 'default')}</w:sectPr>`;
    expect(() =>
      captureHeaderFooter(baseEntries({ documentXml: makeDocXml(sectPr) }), KNOWN)
    ).not.toThrow();
    const result = captureHeaderFooter(baseEntries({ documentXml: makeDocXml(sectPr) }), KNOWN);
    expect(result.composition?.raw?.unmodeled).toEqual([
      expect.objectContaining({
        variant: 'default',
        region: 'header',
        kind: 'unresolvedReference',
      }),
    ]);
  });

  it('does not throw when a resolved reference points at a part that was never read', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header9.xml')),
      headerParts: new Map(), // header9.xml was never populated
    });
    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();
    const result = captureHeaderFooter(entries, KNOWN);
    expect(result.composition?.raw?.unmodeled).toEqual([
      expect.objectContaining({
        variant: 'default',
        region: 'header',
        kind: 'unresolvedReference',
      }),
    ]);
  });

  it('does not throw for a document with a table and an unrecognized field in the header part', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const hdrXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> STYLEREF "Heading 1" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
    </w:hdr>`;
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
    });
    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();
    const result = captureHeaderFooter(entries, KNOWN);
    const kinds = result.composition?.raw?.unmodeled?.map((e) => e.kind) ?? [];
    expect(kinds).toContain('table');
    expect(result.warnings).toHaveLength(1);
  });

  it('propagates ParserError DOCX_HEADER_FOOTER_XML_INVALID for genuinely malformed settings.xml (not remapped, not swallowed)', () => {
    expect(() =>
      captureHeaderFooter(baseEntries({ settingsXml: '<not valid xml' }), KNOWN)
    ).toThrow(/failed to parse/);
  });
});

describe('captureHeaderFooter — two references resolving to the same physical part (no collision)', () => {
  it('captures both default and even header from the same header2.xml without collapsing either', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}${headerRef('rId5', 'even')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        settingsXml: makeSettingsXml('<w:evenAndOddHeaders/>'),
        documentRelsXml: makeRelsXml(
          relationship('rId1', 'header2.xml') + relationship('rId5', 'header2.xml')
        ),
        headerParts: new Map([['word/header2.xml', makeHdrXml('Shared')]]),
      }),
      KNOWN
    );
    const sharedContent = [{ kind: 'literal', text: 'Shared' }];
    expect(result.composition).toMatchObject({
      variants: {
        default: { header: { left: { content: sharedContent } } },
        even: { header: { left: { content: sharedContent } } },
      },
    });
  });
});
