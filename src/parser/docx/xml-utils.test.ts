import { describe, it, expect } from 'vitest';
// XMLBuilder is flagged deprecated (relocated to the separate
// `fast-xml-builder` package) but still ships and works in the pinned
// version — same tradeoff as xml-utils.ts's own import. Used here only to
// build a negative control that pins why createOrderedDocumentXmlBuilder
// sets suppressEmptyNode.
// eslint-disable-next-line sonarjs/deprecation -- intentional: see note above
import { XMLBuilder } from 'fast-xml-parser';
import {
  createDocumentXmlParser,
  createOrderedDocumentXmlParser,
  createOrderedDocumentXmlBuilder,
  getAttrVal,
  getAttrNumVal,
  extractAttrStr,
  toArray,
} from './xml-utils.js';
import { ObjectBlobNodeSchema } from '../../ast/index.js';

// The factory is the single source of the document.xml parser config shared by
// document.ts and tables.ts (#293). These pin the config guarantees the reused
// text/vanish helpers depend on, so drift (or a bad refactor) fails here — not silently
// in one scanner. See the #22/#120 rationale on createDocumentXmlParser.
describe('createDocumentXmlParser', () => {
  interface Run {
    readonly 'w:t'?: unknown;
  }
  interface Para {
    readonly 'w:r'?: readonly Run[];
    readonly 'w:pPr'?: unknown;
  }
  const parseP = (xml: string): Para | undefined => {
    const parsed = createDocumentXmlParser(['w:p', 'w:r']).parse(xml) as {
      readonly 'w:p'?: readonly Para[];
    };
    return parsed['w:p']?.[0];
  };
  const firstRunText = (xml: string): unknown => parseP(xml)?.['w:r']?.[0]?.['w:t'];

  it('keeps a bare-integer w:t run as a string, never coerced to a number (#120)', () => {
    expect(firstRunText('<w:p><w:r><w:t>9</w:t></w:r></w:p>')).toBe('9');
  });

  it('preserves leading/trailing whitespace in w:t text (trimValues: false)', () => {
    expect(firstRunText('<w:p><w:r><w:t> x </w:t></w:r></w:p>')).toBe(' x ');
  });

  it('decodes OOXML entities in text (processEntities: true)', () => {
    expect(firstRunText('<w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p>')).toBe('a & b');
  });

  it('forces the requested tags to arrays even when a single element is present', () => {
    expect(Array.isArray(parseP('<w:p><w:r><w:t>only</w:t></w:r></w:p>')?.['w:r'])).toBe(true);
  });

  it('does not array-wrap a tag outside the requested set', () => {
    expect(Array.isArray(parseP('<w:p><w:pPr/><w:r><w:t>x</w:t></w:r></w:p>')?.['w:pPr'])).toBe(
      false
    );
  });
});

describe('getAttrVal', () => {
  it('returns string value from @_w:val', () => {
    expect(getAttrVal({ '@_w:val': 'decimal' })).toBe('decimal');
  });

  it('converts numeric @_w:val to string', () => {
    expect(getAttrVal({ '@_w:val': 3 })).toBe('3');
  });

  it('returns empty string when @_w:val is missing', () => {
    expect(getAttrVal({ other: 'x' })).toBe('');
  });

  it('returns empty string for non-object input', () => {
    expect(getAttrVal('literal')).toBe('');
    expect(getAttrVal(null)).toBe('');
    expect(getAttrVal(undefined)).toBe('');
  });
});

describe('getAttrNumVal', () => {
  it('parses numeric string to int', () => {
    expect(getAttrNumVal({ '@_w:val': '4' })).toBe(4);
  });

  it('returns 0 for unparseable value', () => {
    expect(getAttrNumVal({})).toBe(0);
  });
});

describe('extractAttrStr', () => {
  it('extracts string attribute', () => {
    expect(extractAttrStr({ '@_w:numId': '1' }, '@_w:numId')).toBe('1');
  });

  it('converts numeric attribute to string', () => {
    expect(extractAttrStr({ '@_w:abstractNumId': 0 }, '@_w:abstractNumId')).toBe('0');
  });

  it('returns empty string for missing key', () => {
    expect(extractAttrStr({}, '@_w:missing')).toBe('');
  });
});

describe('toArray', () => {
  it('wraps single item in array', () => {
    expect(toArray('x')).toEqual(['x']);
  });

  it('returns array as-is', () => {
    expect(toArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns empty array for undefined', () => {
    expect(toArray(undefined)).toEqual([]);
  });
});

// A realistic body-level table fragment (#300, ADR-072): mixed self-closing
// empty elements (w:tblW, w:gridCol, w:tcPr>w:tcW, w:pPr) alongside text
// runs, an entity, and a bare-integer run — the exact shapes
// createOrderedDocumentXmlParser/Builder must round-trip byte-for-byte when
// captured as an object's `blob`.
const TABLE_XML =
  '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid>' +
  '<w:tr><w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr>' +
  '<w:p><w:pPr/><w:r><w:t>A &amp; B</w:t></w:r></w:p></w:tc>' +
  '<w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr>' +
  '<w:p><w:r><w:t>09</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';

// Shared across every round-trip/shape-stability case below — the same
// parse-then-assert-shape decision repeated 3+ times, per the DRY threshold.
function parseTableXml(): unknown[] {
  return createOrderedDocumentXmlParser().parse(TABLE_XML) as unknown[];
}

describe('createOrderedDocumentXmlParser / createOrderedDocumentXmlBuilder round-trip', () => {
  it('round-trips a table blob byte-identical, including self-closing empty elements', () => {
    const rebuilt = createOrderedDocumentXmlBuilder().build(parseTableXml());
    expect(rebuilt).toBe(TABLE_XML);
  });

  it('preserves entities across the round-trip (processEntities: true)', () => {
    const rebuilt = createOrderedDocumentXmlBuilder().build(parseTableXml());
    expect(rebuilt).toContain('A &amp; B');
  });

  it('keeps a bare-integer w:t run as a string, never coerced to a number (#120)', () => {
    const rebuilt = createOrderedDocumentXmlBuilder().build(parseTableXml());
    // A coerced "09" -> 9 would silently drop the leading zero on rebuild.
    expect(rebuilt).toContain('<w:t>09</w:t>');
  });

  it('is not byte-identical without suppressEmptyNode — pins why the builder sets it', () => {
    // Same base config as createOrderedDocumentXmlBuilder but with the flag
    // this test exists to protect turned off, to prove it is load-bearing
    // (spike measured 18335->21005 char drift on a real table fixture
    // without it — ADR-072). Constructed inline, not exported: this is a
    // negative control, not part of the module's public contract.
    // eslint-disable-next-line sonarjs/deprecation -- see XMLBuilder import note
    const withoutSuppress = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      preserveOrder: true,
      suppressEmptyNode: false,
    }).build(parseTableXml());
    expect(withoutSuppress).not.toBe(TABLE_XML);
    expect(withoutSuppress).toContain('<w:pPr></w:pPr>');
  });
});

describe('createOrderedDocumentXmlParser output — JSONB shape stability', () => {
  it('produces top-level nodes that satisfy ObjectBlobNodeSchema', () => {
    expect(() => ObjectBlobNodeSchema.array().min(1).parse(parseTableXml())).not.toThrow();
  });

  it('survives a JSON.stringify/parse cycle (JSONB storage) with no shape loss', () => {
    const parsed = parseTableXml();
    const jsonRoundTripped = JSON.parse(JSON.stringify(parsed)) as unknown[];

    expect(jsonRoundTripped).toEqual(parsed);
    expect(() => ObjectBlobNodeSchema.array().min(1).parse(jsonRoundTripped)).not.toThrow();
  });

  it('still rebuilds byte-identical XML after a JSONB storage round-trip', () => {
    const jsonRoundTripped = JSON.parse(JSON.stringify(parseTableXml())) as unknown[];
    const rebuilt = createOrderedDocumentXmlBuilder().build(jsonRoundTripped);
    expect(rebuilt).toBe(TABLE_XML);
  });
});
