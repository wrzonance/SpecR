import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ParserError } from '../error.js';
import { MAX_IMAGE_BYTES } from '../../lib/image-media-type.js';
import { captureHeaderFooter, buildComposition } from './header-footer.js';
import type { HeaderFooterCaptureEntries, HeaderFooterCaptureResult } from './header-footer.js';
import { RELS_UNREADABLE_REASON } from './header-footer-media-parts.js';
import type { HeaderFooterMediaByPart } from './header-footer-media-parts.js';

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

// Arbitrary-body variant of makeHdrXml, for fixtures (e.g. the #487 drawing
// tests below) that need more than a single plain-text paragraph.
function makeHdrXmlWithBody(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${bodyXml}</w:hdr>`;
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
    mediaByPart: new Map(),
    ...overrides,
  };
}

// ─── image-resolving drawing run fixture (#487) — mirrors
// header-footer-region.test.ts's own imageDrawingRun fixture, as raw XML
// text (captureHeaderFooter's entries carry part XML as strings).
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

// Wraps per-part rId -> bytes fixtures into the `resolved` HeaderFooterPartMedia
// shape entries.mediaByPart now expects (#502) — mirrors how
// header-footer-media-parts.ts's readPartMedia builds a real one.
function resolvedMediaByPart(
  parts: Readonly<Record<string, readonly (readonly [string, Uint8Array])[]>>
): HeaderFooterMediaByPart {
  return new Map(
    Object.entries(parts).map(([partPath, entries]) => [
      partPath,
      { status: 'resolved' as const, media: new Map(entries) },
    ])
  );
}

// #502 counterpart to resolvedMediaByPart above: wraps a set of part paths
// into the `relsUnreadable` HeaderFooterPartMedia shape — the part's own
// .rels file could not be read/parsed at all, so every reference into it is
// unresolvable by construction. Used by the end-to-end capture-warning
// acceptance tests below.
function relsUnreadableMediaByPart(partPaths: readonly string[]): HeaderFooterMediaByPart {
  return new Map(
    partPaths.map((partPath) => [partPath, { status: 'relsUnreadable' as const, partPath }])
  );
}

// Wraps a drawing run in a w:sdt content control (mirrors header-footer-
// region.test.ts's own sdtRun helper, applied to imageDrawingRun instead of
// plain text) — proves the paragraph-level drawing-resolution path is
// reached through an SDT wrapper too, not just a bare w:r.
function sdtWrappedImage(rId: string): string {
  return (
    '<w:sdt><w:sdtPr><w:id w:val="123"/></w:sdtPr><w:sdtContent>' +
    `${imageDrawingRun(rId)}</w:sdtContent></w:sdt>`
  );
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
    // The simple 1-cell table is now captured into the region (#309,
    // ADR-071) rather than preserved as unmodeled; only the unrecognized
    // STYLEREF field remains unmodeled.
    expect(result.composition?.variants?.default?.header?.table).toEqual({
      rows: [{ cells: [{ content: [{ kind: 'literal', text: 'cell' }] }] }],
    });
    const kinds = result.composition?.raw?.unmodeled?.map((e) => e.kind) ?? [];
    expect(kinds).not.toContain('table');
    expect(kinds).toContain('unrecognizedField');
    expect(result.warnings).toHaveLength(1);
  });

  it('propagates ParserError DOCX_HEADER_FOOTER_XML_INVALID for genuinely malformed settings.xml (not remapped, not swallowed)', () => {
    let caught: unknown;
    try {
      captureHeaderFooter(baseEntries({ settingsXml: '<not valid xml' }), KNOWN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
    expect((caught as ParserError).message).toMatch(/failed to parse/);
  });

  // Pins the orchestrator boundary directly (#306 review): every other test in
  // this describe block only exercises document.xml/rels/settings.xml malformed
  // input, never a malformed header/footer PART itself — so buildVariant's own
  // doc comment claim ("captureRegion's throw propagates unchanged") was
  // untested where it actually matters, through captureHeaderFooter, not just
  // through captureRegion directly (header-footer-region.test.ts already pins
  // that half).
  //
  // INV-6 (#502, ADR-068 addendum): the issue's acceptance criterion 3
  // ("corrupt header1.xml, the part XML itself, still fails the parse") —
  // pre-existing (#306) strictness the #502 spike re-ran unmodified and
  // confirmed still holds; formalized with this label as the closing
  // regression pin for #502's own INV-N set, distinct from INV-1's degrade
  // of the part's `.rels` sidecar, never the part's own body XML.
  it('INV-6: propagates ParserError DOCX_HEADER_FOOTER_XML_INVALID for a malformed header/footer PART XML, via buildVariant, unchanged', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', '<not valid xml']]),
    });
    let caught: unknown;
    try {
      captureHeaderFooter(entries, KNOWN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
    expect((caught as ParserError).message).toMatch(/failed to parse word\/header part XML/);
  });

  // INV-4 (#502, ADR-068 addendum): regression pin for the issue's acceptance
  // criterion 2 ("corrupt document.xml.rels still fails the parse").
  // parseDocumentRelationships' own strictness for malformed
  // document.xml.rels (already pinned directly at
  // header-footer-relationships.test.ts's module boundary) was never
  // exercised through captureHeaderFooter itself — the orchestrator boundary
  // every other malformed-XML test in this block pins directly (settings.xml
  // above, the header/footer PART XML above, INV-6). #502 only ever degrades
  // a header/footer PART's OWN .rels file (word/_rels/header*.xml.rels,
  // resolved eagerly by header-footer-media-parts.ts, never reaching this
  // module) — it must never soften document.xml.rels malformation, which
  // remains a hard parse failure.
  it('INV-4: propagates ParserError DOCX_HEADER_FOOTER_XML_INVALID for malformed document.xml.rels, via captureHeaderFooter, unchanged (#502)', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: '<not valid xml',
    });
    let caught: unknown;
    try {
      captureHeaderFooter(entries, KNOWN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
  });
});

// INVARIANT (ADR-068): buildComposition's final HeaderFooterCompositionSchema
// .parse() call is never wrapped in a try/catch that remaps failure to
// DOCX_HEADER_FOOTER_XML_INVALID — that code is reserved strictly for
// malformed SOURCE XML, never an internal shape defect in the capture code
// itself. Real document content can never produce a candidate that fails this
// validation (every `raw.unmodeled` detail is already compact()-ed JSON-safe
// data, per ADR-068), so this failure path is unreachable through
// captureHeaderFooter's normal input space; buildComposition is exported
// solely to pin this boundary contract directly, the same way this module's
// sibling file (header-footer-field-recognition.ts) exports its own small
// internal helpers for direct testing. `variants` is intentionally typed as a
// loosely-typed `Record<string, unknown>` intermediate (see buildComposition's
// own doc comment) — passing it a shape real capture code could never build
// is exactly what that looseness is for.
describe('buildComposition — internal-defect propagation invariant (ADR-068)', () => {
  it('propagates a raw ZodError, never a ParserError, when the candidate fails HeaderFooterCompositionSchema.parse()', () => {
    let caught: unknown;
    try {
      buildComposition({ default: 'not-an-object' }, [], [], undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    expect(caught).not.toBeInstanceOf(ParserError);
  });
});

// Regression (#306 review): sectionInfo.pgNumStart (w:pgNumType/@w:start) was
// extracted by parseSectionHeaderFooterInfo but never reached the returned
// composition or its raw sidecar — silently discarded. pageNumbering.mode is
// a required field on PageNumberingSchema and a cross-document policy
// decision this single-document capture cannot infer (ADR-068), so the value
// is preserved under raw.pgNumStart (the sidecar's open catchall) plus a
// raw.warnings line, rather than fabricating a mode to populate
// composition.pageNumbering directly.
describe('captureHeaderFooter — pgNumStart preservation (ADR-068)', () => {
  it('preserves w:pgNumType/@w:start under raw.pgNumStart with a raw.warnings line', () => {
    const sectPr = '<w:sectPr><w:pgNumType w:start="3"/></w:sectPr>';
    const result = captureHeaderFooter(baseEntries({ documentXml: makeDocXml(sectPr) }), KNOWN);
    expect(result.composition?.raw?.pgNumStart).toBe(3);
    expect(result.composition?.raw?.warnings).toEqual([expect.stringContaining('pgNumType')]);
    expect(result.warnings).toHaveLength(1);
  });

  it('never fabricates composition.pageNumbering — mode is a cross-document decision this capture cannot infer', () => {
    const sectPr = '<w:sectPr><w:pgNumType w:start="3"/></w:sectPr>';
    const result = captureHeaderFooter(baseEntries({ documentXml: makeDocXml(sectPr) }), KNOWN);
    expect(result.composition?.pageNumbering).toBeUndefined();
  });

  it('does not add raw.pgNumStart or a warning when w:pgNumType is absent', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
        headerParts: new Map([['word/header1.xml', makeHdrXml('Default')]]),
      }),
      KNOWN
    );
    expect(result.composition?.raw).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

// ADR-077: pageSize is a sibling of `composition`/`warnings` on
// HeaderFooterCaptureResult — every document has a page size (unlike the
// occasional pgNumStart), so it is never nested inside composition/raw and
// must survive even when there is no header/footer content to capture at
// all (composition undefined). Reuses sectionInfo.pageSize already computed
// by parseSectionHeaderFooterInfo — no second sectPr parse.
describe('captureHeaderFooter — pageSize pass-through (ADR-077)', () => {
  it('surfaces a fully-populated w:pgSz as a sibling pageSize field, independent of composition', () => {
    const sectPr = '<w:sectPr><w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/></w:sectPr>';
    const result = captureHeaderFooter(baseEntries({ documentXml: makeDocXml(sectPr) }), KNOWN);
    expect(result.pageSize).toEqual({ width: 12240, height: 15840, orientation: 'portrait' });
    expect(result.composition).toBeUndefined();
  });

  it('omits orientation when @w:orient is absent, never fabricating a default', () => {
    const sectPr = '<w:sectPr><w:pgSz w:w="15840" w:h="12240"/></w:sectPr>';
    const result = captureHeaderFooter(baseEntries({ documentXml: makeDocXml(sectPr) }), KNOWN);
    expect(result.pageSize).toEqual({ width: 15840, height: 12240 });
  });

  it('leaves pageSize undefined for a document with no sectPr at all', () => {
    const result = captureHeaderFooter(baseEntries(), KNOWN);
    expect(result.pageSize).toBeUndefined();
  });

  it('leaves pageSize undefined (never a partial shape) when w:pgSz is missing a dimension', () => {
    const sectPr = '<w:sectPr><w:pgSz w:w="12240"/></w:sectPr>';
    const result = captureHeaderFooter(baseEntries({ documentXml: makeDocXml(sectPr) }), KNOWN);
    expect(result.pageSize).toBeUndefined();
  });

  it('surfaces pageSize alongside real header/footer content, unaffected by variant capture', () => {
    const sectPr =
      '<w:sectPr>' +
      '<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>' +
      headerRef('rId1', 'default') +
      '</w:sectPr>';
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
        headerParts: new Map([['word/header1.xml', makeHdrXml('Default')]]),
      }),
      KNOWN
    );
    expect(result.pageSize).toEqual({ width: 12240, height: 15840, orientation: 'portrait' });
    expect(result.composition?.variants?.default?.header).toBeDefined();
  });
});

// Regression (#306 review): findResolvedRef used Array.find(), so when two
// w:headerReference/w:footerReference elements of the SAME (variant, region)
// both resolve to real relationship targets (a non-conforming document — real
// Word never emits this), only the first was captured; the second resolved
// reference's target part was never read and never appeared anywhere in
// raw.unmodeled/raw.warnings. It is now preserved as a duplicate unmodeled
// entry instead of silently vanishing.
describe('captureHeaderFooter — duplicate resolved reference for the same (variant, region) slot (#306 review)', () => {
  it('captures the first resolved default header and preserves the second as unmodeled, not silently dropped', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}${headerRef('rId2', 'default')}</w:sectPr>`;
    const result = captureHeaderFooter(
      baseEntries({
        documentXml: makeDocXml(sectPr),
        documentRelsXml: makeRelsXml(
          relationship('rId1', 'header1.xml') + relationship('rId2', 'header2.xml')
        ),
        headerParts: new Map([
          ['word/header1.xml', makeHdrXml('First')],
          ['word/header2.xml', makeHdrXml('Second')],
        ]),
      }),
      KNOWN
    );
    expect(result.composition?.variants?.default?.header?.left?.content).toEqual([
      { kind: 'literal', text: 'First' },
    ]);
    const duplicateEntry = result.composition?.raw?.unmodeled?.find(
      (e) => e.kind === 'unresolvedReference' && e.variant === 'default' && e.region === 'header'
    );
    expect(duplicateEntry).toBeDefined();
    const duplicateDetail = JSON.stringify(duplicateEntry?.detail);
    expect(duplicateDetail).toContain('word/header2.xml');
    expect(duplicateDetail).toContain('rId2');
    expect(result.warnings).toHaveLength(1);
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

// INVARIANT (#487, ADR-068): an oversize embedded image never reaches
// buildComposition's un-guarded HeaderFooterCompositionSchema.parse() call
// (header-footer.ts has no try/catch around it — see that function's own doc
// comment). resolveDrawingImage's MAX_IMAGE_BYTES cap runs on raw bytes
// BEFORE any field is built, so an oversize image degrades to the same
// `{ kind: 'image' }` unmodeled fallback #306 already emits for an
// unresolvable drawing, never a modeled `image` field with an oversized
// `imageData` string — and, critically, never a thrown ZodError surfacing
// through captureHeaderFooter's public contract (which never throws for
// document-content reasons). This exercises the full orchestrator path —
// entries.mediaByPart -> buildRegionSlot -> buildVariant -> captureRegion ->
// buildCellContent/resolveDrawingImage -> buildComposition — not just
// resolveDrawingImage in isolation (already pinned by
// header-footer-images.test.ts).
describe("captureHeaderFooter — oversize embedded image never reaches buildComposition's un-guarded schema.parse() (#487)", () => {
  it('degrades an oversize embedded image to a raw sidecar + capture warning, never a thrown error', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const hdrXml = makeHdrXmlWithBody(
      `<w:p><w:r><w:t>Logo:</w:t></w:r>${imageDrawingRun('rIdImg1')}</w:p>`
    );
    const mediaByPart = resolvedMediaByPart({
      'word/header1.xml': [['rIdImg1', pngBytes(MAX_IMAGE_BYTES + 1)]],
    });
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      mediaByPart,
    });

    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();

    const result = captureHeaderFooter(entries, KNOWN);
    // The oversize image never reaches the region's content — only the
    // preceding literal text is captured as a modeled field.
    expect(result.composition?.variants?.default?.header?.left?.content).toEqual([
      { kind: 'literal', text: 'Logo:' },
    ]);
    // The oversize image is preserved as an unmodeled sidecar entry, not
    // silently dropped and not promoted to a modeled `image` field.
    const unmodeledKinds = result.composition?.raw?.unmodeled?.map((e) => e.kind) ?? [];
    expect(unmodeledKinds).toContain('image');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ type: 'header-footer-content-skipped' });
  });

  it('accepts an image at exactly the MAX_IMAGE_BYTES cap into a modeled image field (boundary, not off-by-one)', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const hdrXml = makeHdrXmlWithBody(`<w:p>${imageDrawingRun('rIdImg1')}</w:p>`);
    const mediaByPart = resolvedMediaByPart({
      'word/header1.xml': [['rIdImg1', pngBytes(MAX_IMAGE_BYTES)]],
    });
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      mediaByPart,
    });

    const result = captureHeaderFooter(entries, KNOWN);
    expect(result.composition?.variants?.default?.header?.left?.content).toEqual([
      expect.objectContaining({ kind: 'image', imageMediaType: 'image/png' }),
    ]);
  });
});

// INVARIANT (#487, ADR-068): captureHeaderFooter never throws due to embedded
// image content, for ANY of the four ways image resolution can fail — a
// malformed drawing descriptor, an unresolvable relationship (no matching
// media byte for the run's rId), oversize bytes (pinned above, its own
// describe block, since that's the one failure mode with a genuine ordering
// hazard against buildComposition's un-guarded schema.parse()), or unsniffable
// bytes (#306 regression guard). Every case degrades to the same raw sidecar +
// single capture warning, never a thrown error and never a silent drop, run
// through the full orchestrator path (entries.mediaByPart -> buildRegionSlot
// -> buildVariant -> captureRegion -> buildCellContent/resolveDrawingImage ->
// buildComposition) rather than resolveDrawingImage in isolation (already
// unit-pinned by header-footer-images.test.ts).
describe('captureHeaderFooter — malformed/unresolvable/unsniffable embedded image data never throws (#487, ADR-068)', () => {
  it('degrades a malformed drawing (no wp:extent, no descriptor) to a raw sidecar + capture warning, never a thrown error', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const malformedDrawingRun =
      '<w:r><w:drawing><wp:inline><wp:docPr id="1"/></wp:inline></w:drawing></w:r>';
    const hdrXml = makeHdrXmlWithBody(
      `<w:p><w:r><w:t>Logo:</w:t></w:r>${malformedDrawingRun}</w:p>`
    );
    const mediaByPart = resolvedMediaByPart({ 'word/header1.xml': [['rIdImg1', pngBytes()]] });
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      mediaByPart,
    });

    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();

    const result = captureHeaderFooter(entries, KNOWN);
    expect(result.composition?.variants?.default?.header?.left?.content).toEqual([
      { kind: 'literal', text: 'Logo:' },
    ]);
    const unmodeledKinds = result.composition?.raw?.unmodeled?.map((e) => e.kind) ?? [];
    expect(unmodeledKinds).toContain('image');
    expect(result.warnings).toHaveLength(1);
  });

  it("degrades an unresolvable relationship (rId absent from this part's media map) to a raw sidecar + capture warning, never a thrown error", () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const hdrXml = makeHdrXmlWithBody(
      `<w:p><w:r><w:t>Logo:</w:t></w:r>${imageDrawingRun('rIdImg1')}</w:p>`
    );
    // The part's media map exists but has no entry for rIdImg1 — the
    // relationship's target was never resolved (e.g. dropped during the
    // async extraction phase), not the same case as no map at all.
    const mediaByPart = resolvedMediaByPart({ 'word/header1.xml': [['rIdOther', pngBytes()]] });
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      mediaByPart,
    });

    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();

    const result = captureHeaderFooter(entries, KNOWN);
    expect(result.composition?.variants?.default?.header?.left?.content).toEqual([
      { kind: 'literal', text: 'Logo:' },
    ]);
    const unmodeledKinds = result.composition?.raw?.unmodeled?.map((e) => e.kind) ?? [];
    expect(unmodeledKinds).toContain('image');
    expect(result.warnings).toHaveLength(1);
  });

  it('degrades unsniffable bytes (no known magic-byte signature) to a raw sidecar + capture warning, never a thrown error (#306 regression guard)', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const hdrXml = makeHdrXmlWithBody(
      `<w:p><w:r><w:t>Logo:</w:t></w:r>${imageDrawingRun('rIdImg1')}</w:p>`
    );
    const garbageBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const mediaByPart = resolvedMediaByPart({ 'word/header1.xml': [['rIdImg1', garbageBytes]] });
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      mediaByPart,
    });

    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();

    const result = captureHeaderFooter(entries, KNOWN);
    expect(result.composition?.variants?.default?.header?.left?.content).toEqual([
      { kind: 'literal', text: 'Logo:' },
    ]);
    const unmodeledKinds = result.composition?.raw?.unmodeled?.map((e) => e.kind) ?? [];
    expect(unmodeledKinds).toContain('image');
    expect(result.warnings).toHaveLength(1);
  });
});

// INVARIANT (#487, ADR-071 decision 4): a table cell's drawing run is filtered
// out by header-footer-table.ts's own pre-filter BEFORE buildCellContent ever
// sees it, and captureTablesForRegion is deliberately never given a
// mediaByRId slice (header-footer-region.ts's captureRegion doc comment) — so
// buildCellContent's new drawing branch is structurally unreachable from a
// table cell's capture path. This holds even when the referenced image WOULD
// resolve to a valid modeled field outside a table cell (proving the
// pre-filter, not merely an incidentally-unresolvable rId) — the same
// well-formed, resolvable drawing run and mediaByPart entry used by the
// paragraph-level image tests above, placed inside a table cell instead.
// Extracted from the test body below purely to keep the assertion's own
// complexity within eslint's cap — flattens every cell's content across a
// captured table's rows and keeps only `image`-kind fields.
function imageFieldsInTableCells(
  rows: readonly { readonly cells: readonly { readonly content?: readonly { kind: string }[] }[] }[]
): readonly { kind: string }[] {
  return rows
    .flatMap((row) => row.cells)
    .flatMap((cell) => cell.content ?? [])
    .filter((field) => field.kind === 'image');
}

describe('captureHeaderFooter — table-cell image never resolves to a modeled field (#487, ADR-071 decision 4)', () => {
  it('drops a well-formed, resolvable image inside a table cell as unmodeled, never as a modeled image field', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    const tableXml =
      '<w:tbl><w:tr><w:tc><w:p>' +
      '<w:r><w:t>Logo: </w:t></w:r>' +
      imageDrawingRun('rIdImg1') +
      '</w:p></w:tc></w:tr></w:tbl>';
    const hdrXml = makeHdrXmlWithBody(tableXml);
    const mediaByPart = resolvedMediaByPart({ 'word/header1.xml': [['rIdImg1', pngBytes()]] });
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      mediaByPart,
    });

    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();

    const composition = captureHeaderFooter(entries, KNOWN).composition;
    const rows = composition?.variants?.default?.header?.table?.rows;
    expect(rows).toEqual([{ cells: [{ content: [{ kind: 'literal', text: 'Logo: ' }] }] }]);
    expect(composition?.raw?.unmodeled?.some((entry) => entry.kind === 'image')).toBe(true);
    // No cell in any row ever carries a modeled `image` field.
    expect(imageFieldsInTableCells(rows ?? [])).toEqual([]);
  });
});

// Small result accessors, extracted purely to keep each `it()` body's own
// cyclomatic complexity under eslint's enforced cap of 10 — a single test
// asserting on several optional-chained result fields (composition ->
// variants -> a specific variant -> header/footer -> a cell) accumulates
// enough branches on its own to trip the cap; each accessor here carries
// only its own slice of that chain (mirrors imageFieldsInTableCells' own
// extraction above, and header-footer-region.ts's "spike learning #2" doc
// comment about complexity-driven extraction).
function defaultHeaderOf(result: HeaderFooterCaptureResult) {
  return result.composition?.variants?.default?.header;
}

function firstHeaderOf(result: HeaderFooterCaptureResult) {
  return result.composition?.variants?.first?.header;
}

function rawWarningsOf(result: HeaderFooterCaptureResult): readonly string[] | undefined {
  return result.composition?.raw?.warnings;
}

function rawUnmodeledKindsOf(result: HeaderFooterCaptureResult): readonly string[] {
  return (result.composition?.raw?.unmodeled ?? []).map((entry) => entry.kind);
}

function rawUnresolvedReferenceDetailsOf(result: HeaderFooterCaptureResult): readonly unknown[] {
  return (result.composition?.raw?.unmodeled ?? [])
    .filter((entry) => entry.kind === 'unresolvedReference')
    .map((entry) => entry.detail);
}

// End-to-end acceptance for #502 (issue: a header/footer part whose OWN
// .rels file is corrupt/unreadable must never fail the whole DOCX parse, and
// every image reference into it must collapse to exactly ONE part-level
// capture warning, not one generic "image content not modeled" line per
// drawing). Runs the full orchestrator path — entries.mediaByPart ->
// buildRegionSlot -> buildVariant -> captureRegion ->
// captureFromParagraphs/captureTablesForRegion -> buildRawWarnings ->
// buildComposition — combining what header-footer-images.test.ts,
// header-footer-table.test.ts, header-footer-region.test.ts, and
// header-footer-media-warnings.test.ts each already pin in isolation at
// their own module boundary.
describe('captureHeaderFooter — corrupt header/footer .rels degrades to per-part capture warnings, never throws (#502)', () => {
  it('captures text/fields/tables normally and counts BOTH an SDT-wrapped paragraph drawing and a table-cell drawing into one aggregate warning', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}</w:sectPr>`;
    // First content-bearing paragraph: literal text (left) + a recognized
    // PAGE field (center) + an SDT-wrapped drawing (right — never becomes
    // cell content; only its unmodeled trace survives).
    const paragraphXml =
      '<w:p>' +
      '<w:r><w:t>Confidential</w:t></w:r>' +
      '<w:r><w:tab/></w:r>' +
      '<w:fldSimple w:instr=" PAGE "><w:r><w:t>3</w:t></w:r></w:fldSimple>' +
      '<w:r><w:tab/></w:r>' +
      sdtWrappedImage('rIdSdtImg') +
      '</w:p>';
    // A root-level table whose only cell mixes literal text with a second,
    // independent drawing run — table-cell images are always out of scope
    // for content (ADR-071 decision 4), but #502 still needs this one
    // counted toward the SAME damaged part's aggregate warning.
    const tableXml =
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Logo: </w:t></w:r>' +
      imageDrawingRun('rIdTableImg') +
      '</w:p></w:tc></w:tr></w:tbl>';
    const hdrXml = makeHdrXmlWithBody(paragraphXml + tableXml);
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(relationship('rId1', 'header1.xml')),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      mediaByPart: relsUnreadableMediaByPart(['word/header1.xml']),
    });

    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();

    const result = captureHeaderFooter(entries, KNOWN);
    const header = defaultHeaderOf(result);
    // Text and the recognized PAGE field are captured normally — a damaged
    // .rels file only degrades image resolution, nothing else.
    expect(header).toMatchObject({
      left: { content: [{ kind: 'literal', text: 'Confidential' }] },
      center: { content: [{ kind: 'pageNumber' }] },
      table: { rows: [{ cells: [{ content: [{ kind: 'literal', text: 'Logo: ' }] }] }] },
    });
    // The SDT-wrapped drawing never becomes cell content — only its
    // unmodeled trace, asserted below, survives.
    expect(header?.right).toBeUndefined();

    // Both drawings — the SDT-wrapped paragraph one AND the table-cell one —
    // degrade to unresolvedReference (never the generic `image` unmodeled
    // fallback), and both are attributed to the SAME damaged part.
    const unresolvedDetails = rawUnresolvedReferenceDetailsOf(result);
    expect(unresolvedDetails).toHaveLength(2);
    expect(unresolvedDetails).toContainEqual({
      rId: 'rIdSdtImg',
      part: 'word/header1.xml',
      reason: RELS_UNREADABLE_REASON,
    });
    expect(unresolvedDetails).toContainEqual({
      part: 'word/header1.xml',
      reason: RELS_UNREADABLE_REASON,
    });
    // Neither drawing ever falls back to the generic `image` unmodeled kind
    // — both are attributed to the damaged part instead.
    expect(rawUnmodeledKindsOf(result)).not.toContain('image');

    // Exactly ONE aggregate capture-warning line for the damaged part, exact
    // wording, counting BOTH drawings — never one generic line per drawing.
    expect(rawWarningsOf(result)).toEqual([
      "word/header1.xml's relationships index is unreadable; 2 image reference(s) could not be resolved",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ type: 'header-footer-content-skipped' });
  });

  it('emits two separate aggregate warnings, never merged, when two different parts are both damaged', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}${footerRef('rId2', 'default')}</w:sectPr>`;
    const hdrXml = makeHdrXmlWithBody(`<w:p>${imageDrawingRun('rIdHdrImg')}</w:p>`);
    const ftrXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p>${imageDrawingRun('rIdFtrImg')}</w:p></w:ftr>`;
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(
        relationship('rId1', 'header1.xml') + relationship('rId2', 'footer1.xml')
      ),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      footerParts: new Map([['word/footer1.xml', ftrXml]]),
      mediaByPart: relsUnreadableMediaByPart(['word/header1.xml', 'word/footer1.xml']),
    });

    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();

    const result = captureHeaderFooter(entries, KNOWN);
    // Two distinct damaged parts each get their OWN line — the aggregation
    // groups by part path, never collapsing two different parts into one.
    expect(rawWarningsOf(result)).toEqual([
      "word/header1.xml's relationships index is unreadable; 1 image reference(s) could not be resolved",
      "word/footer1.xml's relationships index is unreadable; 1 image reference(s) could not be resolved",
    ]);
    expect(result.warnings).toHaveLength(1);
  });

  it('dedupes the same damaged physical part referenced by two different variant slots into one warning with a summed count', () => {
    // default and first both resolve to the SAME physical header2.xml part
    // (mirrors the pre-existing "two references resolving to the same
    // physical part" test above), and that shared part's .rels is damaged.
    const sectPr = `<w:sectPr><w:titlePg/>${headerRef('rId1', 'default')}${headerRef('rId5', 'first')}</w:sectPr>`;
    const hdrXml = makeHdrXmlWithBody(
      `<w:p><w:r><w:t>Shared</w:t></w:r>${imageDrawingRun('rIdSharedImg')}</w:p>`
    );
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(
        relationship('rId1', 'header2.xml') + relationship('rId5', 'header2.xml')
      ),
      headerParts: new Map([['word/header2.xml', hdrXml]]),
      mediaByPart: relsUnreadableMediaByPart(['word/header2.xml']),
    });

    expect(() => captureHeaderFooter(entries, KNOWN)).not.toThrow();

    const result = captureHeaderFooter(entries, KNOWN);
    // Both variants still capture their shared text content — the damaged
    // .rels file only degrades the image, exactly like the single-variant
    // scenario above.
    const sharedText = [{ kind: 'literal', text: 'Shared' }];
    expect(defaultHeaderOf(result)?.left?.content).toEqual(sharedText);
    expect(firstHeaderOf(result)?.left?.content).toEqual(sharedText);
    // ONE aggregate line, its count summed across both variant slots that
    // reference the same physical part — never two lines, never doubled.
    expect(rawWarningsOf(result)).toEqual([
      "word/header2.xml's relationships index is unreadable; 2 image reference(s) could not be resolved",
    ]);
    expect(result.warnings).toHaveLength(1);
  });

  // INV-10 (#502, ADR-068 addendum): #502's degrade-not-throw behavior is
  // strictly scoped to a part's OWN corrupt .rels — it does not soften
  // header/footer PART-XML-ITSELF strictness elsewhere in the SAME
  // document. Every other test in this describe block exercises a
  // relsUnreadable part in isolation; this one combines it with a
  // genuinely malformed sibling part to prove the two failure modes
  // coexist without one masking the other (readHeaderFooterMedia's async
  // extraction phase vs. captureRegion's synchronous part-XML parse are
  // structurally independent code paths, not a single generalized
  // try/catch).
  it('INV-10: a relsUnreadable header part degrades normally while a genuinely malformed footer PART XML in the SAME document still throws, unaffected by the header degrade', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}${footerRef('rId2', 'default')}</w:sectPr>`;
    const hdrXml = makeHdrXmlWithBody(`<w:p>${imageDrawingRun('rIdHdrImg')}</w:p>`);
    const entries = baseEntries({
      documentXml: makeDocXml(sectPr),
      documentRelsXml: makeRelsXml(
        relationship('rId1', 'header1.xml') + relationship('rId2', 'footer1.xml')
      ),
      headerParts: new Map([['word/header1.xml', hdrXml]]),
      footerParts: new Map([['word/footer1.xml', '<not valid xml']]),
      mediaByPart: relsUnreadableMediaByPart(['word/header1.xml']),
    });

    let caught: unknown;
    try {
      captureHeaderFooter(entries, KNOWN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
  });
});
