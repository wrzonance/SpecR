import { describe, it, expect } from 'vitest';
import { ParserError } from '../error.js';
import {
  parseDocumentRelationships,
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
