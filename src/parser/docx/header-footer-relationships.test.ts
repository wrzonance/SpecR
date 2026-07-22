import { describe, it, expect } from 'vitest';
import { ParserError } from '../error.js';
import {
  parseDocumentRelationships,
  parseImageRelationships,
  parseSectionHeaderFooterInfo,
  parseDocumentSettings,
  resolveReferenceTargets,
} from './header-footer-relationships.js';
import type { HeaderFooterReference } from './types.js';

function makeRelsXml(relationships: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function relationship(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
}

function makeDocXml(sectPr: string, extraBodyXml = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Body paragraph.</w:t></w:r></w:p>
    ${extraBodyXml}
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

function makeSettingsXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:settings>`;
}

describe('parseDocumentRelationships', () => {
  it('parses Id/Target pairs, normalizing a relative Target into a word/-prefixed zip path', () => {
    const xml = makeRelsXml(
      relationship('rId1', 'header', 'header1.xml') + relationship('rId2', 'footer', 'footer1.xml')
    );
    const map = parseDocumentRelationships(xml);
    expect(map.get('rId1')).toBe('word/header1.xml');
    expect(map.get('rId2')).toBe('word/footer1.xml');
  });

  it('normalizes a package-absolute Target by stripping the leading slash instead of double-prefixing', () => {
    const xml = makeRelsXml(relationship('rId1', 'header', '/word/header1.xml'));
    const map = parseDocumentRelationships(xml);
    expect(map.get('rId1')).toBe('word/header1.xml');
  });

  it('returns an empty map for a null (absent) relationships file', () => {
    expect(parseDocumentRelationships(null).size).toBe(0);
  });

  it('returns an empty map for an empty-string relationships file', () => {
    expect(parseDocumentRelationships('  ').size).toBe(0);
  });

  it('throws ParserError DOCX_HEADER_FOOTER_XML_INVALID with cause for malformed XML', () => {
    let caught: unknown;
    try {
      parseDocumentRelationships('<not valid xml');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
    expect((caught as ParserError).cause).toBeDefined();
  });
});

describe('parseImageRelationships', () => {
  it('parses Id/Target pairs for a header/footer part, normalizing the Target the same way as parseDocumentRelationships', () => {
    const xml = makeRelsXml(relationship('rId1', 'image', 'media/image1.png'));
    const map = parseImageRelationships(xml, 'word/header1.xml');
    expect(map.get('rId1')).toBe('word/media/image1.png');
  });

  it('filters out relationships whose Type is not the image relationship URI', () => {
    const xml = makeRelsXml(
      relationship('rId1', 'image', 'media/image1.png') +
        relationship('rId2', 'hyperlink', 'https://example.com/') +
        relationship('rId3', 'footnotes', 'footnotes.xml')
    );
    const map = parseImageRelationships(xml, 'word/header1.xml');
    expect(map.size).toBe(1);
    expect(map.get('rId1')).toBe('word/media/image1.png');
    expect(map.get('rId2')).toBeUndefined();
    expect(map.get('rId3')).toBeUndefined();
  });

  it('returns an empty map for a null (absent) relationships file', () => {
    expect(parseImageRelationships(null, 'word/header1.xml').size).toBe(0);
  });

  it('returns an empty map for an empty-string relationships file', () => {
    expect(parseImageRelationships('  ', 'word/header1.xml').size).toBe(0);
  });

  it('throws ParserError DOCX_HEADER_FOOTER_XML_INVALID with cause and the given partLabel for malformed XML', () => {
    let caught: unknown;
    try {
      parseImageRelationships('<not valid xml', 'word/header3.xml');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
    expect((caught as ParserError).cause).toBeDefined();
    expect((caught as ParserError).message).toContain('word/header3.xml');
  });
});

describe('parseSectionHeaderFooterInfo', () => {
  it('reads default/first/even header and footer references off the trailing body-level w:sectPr', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'default')}${headerRef('rId2', 'first')}${headerRef('rId3', 'even')}${footerRef('rId4', 'default')}</w:sectPr>`;
    const info = parseSectionHeaderFooterInfo(makeDocXml(sectPr));
    expect(info.references).toEqual<readonly HeaderFooterReference[]>([
      { variant: 'default', region: 'header', rId: 'rId1' },
      { variant: 'first', region: 'header', rId: 'rId2' },
      { variant: 'even', region: 'header', rId: 'rId3' },
      { variant: 'default', region: 'footer', rId: 'rId4' },
    ]);
  });

  it('sets titlePg true only when w:titlePg is present', () => {
    const withTitlePg = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:titlePg/></w:sectPr>')
    );
    expect(withTitlePg.titlePg).toBe(true);
    const without = parseSectionHeaderFooterInfo(makeDocXml('<w:sectPr/>'));
    expect(without.titlePg).toBe(false);
  });

  // Regression (#306 review): CT_OnOff (ECMA-376 §17.17.4) is a toggle, not a
  // presence flag — a document can carry an EXPLICIT off value
  // (<w:titlePg w:val="0"/>), which must read as false, matching the
  // established @w:val convention (resolver.ts's toggle(), comments.ts's
  // isStrikeOn()) rather than the mere-presence check this codebase uses
  // everywhere else for CT_OnOff elements.
  it.each(['0', 'false', 'off'])(
    'sets titlePg false when w:titlePg carries an explicit off toggle (@w:val=%s)',
    (val) => {
      const info = parseSectionHeaderFooterInfo(
        makeDocXml(`<w:sectPr><w:titlePg w:val="${val}"/></w:sectPr>`)
      );
      expect(info.titlePg).toBe(false);
    }
  );

  it('sets titlePg true when w:titlePg carries an explicit on toggle (@w:val="1")', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:titlePg w:val="1"/></w:sectPr>')
    );
    expect(info.titlePg).toBe(true);
  });

  it('reads pgNumStart from w:pgNumType/@w:start when present', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgNumType w:start="3"/></w:sectPr>')
    );
    expect(info.pgNumStart).toBe(3);
  });

  it('leaves pgNumStart undefined when w:pgNumType is absent', () => {
    const info = parseSectionHeaderFooterInfo(makeDocXml('<w:sectPr/>'));
    expect(info.pgNumStart).toBeUndefined();
  });

  it('flags hasAdditionalSectionBreaks when the body has a w:pPr/w:sectPr beyond the trailing one', () => {
    const midBreak = `<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>section break</w:t></w:r></w:p>`;
    const info = parseSectionHeaderFooterInfo(makeDocXml('<w:sectPr/>', midBreak));
    expect(info.hasAdditionalSectionBreaks).toBe(true);
  });

  it('does not flag hasAdditionalSectionBreaks for an ordinary single-section document', () => {
    const info = parseSectionHeaderFooterInfo(makeDocXml('<w:sectPr/>'));
    expect(info.hasAdditionalSectionBreaks).toBe(false);
  });

  it('returns empty defaults when the body has no trailing w:sectPr at all', () => {
    const info = parseSectionHeaderFooterInfo(makeDocXml(''));
    expect(info).toEqual({ references: [], titlePg: false, hasAdditionalSectionBreaks: false });
  });

  // Real Word output only ever emits w:type="default|first|even" (ST_HdrFtr). A
  // reference with an unrecognized type is never fabricated into the result —
  // it is simply not a decidable header/footer reference this parser models.
  it('filters out a w:headerReference whose w:type is not default/first/even', () => {
    const sectPr = `<w:sectPr>${headerRef('rId1', 'bogus')}${headerRef('rId2', 'default')}</w:sectPr>`;
    const info = parseSectionHeaderFooterInfo(makeDocXml(sectPr));
    expect(info.references).toEqual([{ variant: 'default', region: 'header', rId: 'rId2' }]);
  });

  it('throws ParserError DOCX_HEADER_FOOTER_XML_INVALID with cause for malformed XML', () => {
    let caught: unknown;
    try {
      parseSectionHeaderFooterInfo('<not valid xml');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
    expect((caught as ParserError).cause).toBeDefined();
  });
});

describe('parseDocumentSettings', () => {
  it('reads evenAndOddHeaders true when w:evenAndOddHeaders is present', () => {
    expect(parseDocumentSettings(makeSettingsXml('<w:evenAndOddHeaders/>')).evenAndOddHeaders).toBe(
      true
    );
  });

  it('reads evenAndOddHeaders false when absent from a present settings.xml', () => {
    expect(parseDocumentSettings(makeSettingsXml('')).evenAndOddHeaders).toBe(false);
  });

  // Regression (#306 review): same CT_OnOff toggle convention as w:titlePg
  // above — an explicit off value must read as false, not be treated as
  // active merely because the element is present.
  it.each(['0', 'false', 'off'])(
    'reads evenAndOddHeaders false when it carries an explicit off toggle (@w:val=%s)',
    (val) => {
      const settings = parseDocumentSettings(
        makeSettingsXml(`<w:evenAndOddHeaders w:val="${val}"/>`)
      );
      expect(settings.evenAndOddHeaders).toBe(false);
    }
  );

  it('reads evenAndOddHeaders true when it carries an explicit on toggle (@w:val="1")', () => {
    const settings = parseDocumentSettings(makeSettingsXml('<w:evenAndOddHeaders w:val="1"/>'));
    expect(settings.evenAndOddHeaders).toBe(true);
  });

  it('returns evenAndOddHeaders false for a null (absent) settings.xml', () => {
    expect(parseDocumentSettings(null).evenAndOddHeaders).toBe(false);
  });

  it('throws ParserError DOCX_HEADER_FOOTER_XML_INVALID with cause for malformed XML', () => {
    let caught: unknown;
    try {
      parseDocumentSettings('<not valid xml');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParserError);
    expect((caught as ParserError).code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
    expect((caught as ParserError).cause).toBeDefined();
  });
});

describe('parseSectionHeaderFooterInfo — pageSize (#509, ADR-075)', () => {
  it('reads width/height/orientation from w:pgSz on the trailing body-level w:sectPr (Letter portrait)', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/></w:sectPr>')
    );
    expect(info.pageSize).toEqual({ width: 12240, height: 15840, orientation: 'portrait' });
  });

  it('reads a landscape A4 w:pgSz', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>')
    );
    expect(info.pageSize).toEqual({ width: 16838, height: 11906, orientation: 'landscape' });
  });

  it('omits orientation when @w:orient is absent, without fabricating a default', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>')
    );
    expect(info.pageSize).toEqual({ width: 12240, height: 15840 });
    expect(info.pageSize).not.toHaveProperty('orientation');
  });

  it('leaves pageSize undefined when w:pgSz is absent from the trailing w:sectPr', () => {
    const info = parseSectionHeaderFooterInfo(makeDocXml('<w:sectPr/>'));
    expect(info.pageSize).toBeUndefined();
  });

  it('leaves pageSize undefined (never a partial shape) when w:pgSz is missing @w:h', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="12240"/></w:sectPr>')
    );
    expect(info.pageSize).toBeUndefined();
  });

  it('leaves pageSize undefined when a dimension is non-positive (zero)', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="0" w:h="15840"/></w:sectPr>')
    );
    expect(info.pageSize).toBeUndefined();
  });

  it('leaves pageSize undefined when a dimension is negative', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="-100" w:h="15840"/></w:sectPr>')
    );
    expect(info.pageSize).toBeUndefined();
  });

  it('leaves pageSize undefined when a dimension is non-numeric', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="abc" w:h="15840"/></w:sectPr>')
    );
    expect(info.pageSize).toBeUndefined();
  });

  // Regression guard: parseInt('12240abc', 10) === 12240 — a leading numeric
  // prefix followed by trailing garbage is NOT the same as isNaN, so a naive
  // parseInt-based guard silently accepts a malformed @w:w/@w:h instead of
  // failing closed to undefined. A well-formed OOXML producer never emits
  // this, but the parser boundary must not trust that — fail closed on any
  // string that isn't purely numeric, not merely non-numeric.
  it('leaves pageSize undefined when a dimension has a valid numeric prefix but trailing garbage', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="12240abc" w:h="15840"/></w:sectPr>')
    );
    expect(info.pageSize).toBeUndefined();
  });

  // Regression guard (#509, ADR-075): Number('12240.5') === 12240.5 is finite
  // and positive, so a Number.isFinite-only guard would admit a fractional twip
  // that PageSizeSchema (.int()) rejects — a schema-validated tree would fail
  // the whole spec, while a direct parse→generate would let the docx library
  // silently floor it. The parser boundary must fail closed on non-integers.
  it('leaves pageSize undefined when a dimension is a positive but fractional twip', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="12240.5" w:h="15840"/></w:sectPr>')
    );
    expect(info.pageSize).toBeUndefined();
  });

  it('drops an unrecognized @w:orient value instead of fabricating one', () => {
    const info = parseSectionHeaderFooterInfo(
      makeDocXml('<w:sectPr><w:pgSz w:w="12240" w:h="15840" w:orient="sideways"/></w:sectPr>')
    );
    expect(info.pageSize).toEqual({ width: 12240, height: 15840 });
  });

  // KNOWN AMBIGUITY (ADR-068 single-sectPr scope, extended by ADR-075 to
  // pageSize): a document with a mid-body w:pPr/w:sectPr section break can
  // declare a DIFFERENT w:pgSz for that earlier section than the trailing
  // body-level one this parser reads. This capture models only the single
  // trailing section's page size — a per-section page-size sequence is not
  // decidable from this slice, and is surfaced only indirectly via the
  // existing hasAdditionalSectionBreaks flag, not by fabricating a merged
  // or first-section page size.
  it('KNOWN AMBIGUITY: only the trailing w:sectPr pageSize is captured when an earlier section break declares a different page size', () => {
    const midBreakWithDifferentPageSize = `<w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:pPr><w:r><w:t>section break</w:t></w:r></w:p>`;
    const info = parseSectionHeaderFooterInfo(
      makeDocXml(
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/></w:sectPr>',
        midBreakWithDifferentPageSize
      )
    );
    expect(info.pageSize).toEqual({ width: 12240, height: 15840, orientation: 'portrait' });
    expect(info.hasAdditionalSectionBreaks).toBe(true);
  });
});

describe('resolveReferenceTargets', () => {
  it('resolves a reference whose rId is present in the relationship map', () => {
    const references: readonly HeaderFooterReference[] = [
      { variant: 'default', region: 'header', rId: 'rId1' },
    ];
    const relationships = new Map([['rId1', 'word/header1.xml']]);
    const result = resolveReferenceTargets(references, relationships);
    expect(result.resolved).toEqual([{ reference: references[0], target: 'word/header1.xml' }]);
    expect(result.unresolved).toEqual([]);
  });

  it('reports a reference unresolved when its rId has no matching relationship', () => {
    const references: readonly HeaderFooterReference[] = [
      { variant: 'first', region: 'header', rId: 'rIdMissing' },
    ];
    const result = resolveReferenceTargets(references, new Map());
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual(references);
  });

  // INVARIANT: resolveReferenceTargets never loses a resolved reference to a
  // keying collision. Two distinct reference slots (default header, even
  // header) legitimately resolving to the SAME physical part (the author never
  // customized the even-page header, so Word points both relationships at
  // header2.xml) must both survive in `resolved` — a Map keyed by target path
  // would silently collapse them into one entry.
  it('never collapses two references that resolve to the same target path', () => {
    const references: readonly HeaderFooterReference[] = [
      { variant: 'default', region: 'header', rId: 'rId1' },
      { variant: 'even', region: 'header', rId: 'rId5' },
    ];
    const relationships = new Map([
      ['rId1', 'word/header2.xml'],
      ['rId5', 'word/header2.xml'],
    ]);
    const result = resolveReferenceTargets(references, relationships);
    expect(result.resolved).toHaveLength(2);
    expect(result.resolved).toEqual([
      { reference: references[0], target: 'word/header2.xml' },
      { reference: references[1], target: 'word/header2.xml' },
    ]);
  });
});
