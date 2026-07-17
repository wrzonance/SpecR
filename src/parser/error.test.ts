import { describe, it, expect } from 'vitest';
import { ParserError } from './error.js';

describe('ParserError — DOCX_TABLE_XML_INVALID code (#293)', () => {
  it('accepts DOCX_TABLE_XML_INVALID as a ParserErrorCode and preserves cause', () => {
    const cause = new Error('malformed table markup');
    const err = new ParserError('failed to scan tables in word/document.xml', {
      code: 'DOCX_TABLE_XML_INVALID',
      cause,
    });
    expect(err.code).toBe('DOCX_TABLE_XML_INVALID');
    expect(err.cause).toBe(cause);
  });
});

// #306, ADR-068: reserved strictly for malformed-but-present word/settings.xml,
// word/_rels/document.xml.rels, or header*/footer*.xml — the same "source XML
// itself doesn't parse" scope as DOCX_TABLE_XML_INVALID above. It must NEVER be
// used to report an internal shape defect (e.g. a failing
// HeaderFooterCompositionSchema.parse() at the header-footer.ts orchestrator
// boundary) — that would misattribute a capture-code bug to the source
// document. That boundary invariant is pinned where captureHeaderFooter is
// implemented (header-footer.test.ts, #306); this file only pins that the
// code itself is a valid, cause-preserving ParserErrorCode.
describe('ParserError — DOCX_HEADER_FOOTER_XML_INVALID code (#306)', () => {
  it('accepts DOCX_HEADER_FOOTER_XML_INVALID as a ParserErrorCode and preserves cause', () => {
    const cause = new Error('malformed relationship markup');
    const err = new ParserError('failed to parse word/_rels/document.xml.rels', {
      code: 'DOCX_HEADER_FOOTER_XML_INVALID',
      cause,
    });
    expect(err.code).toBe('DOCX_HEADER_FOOTER_XML_INVALID');
    expect(err.cause).toBe(cause);
  });
});

// #300, ADR-072: reserved for body-order.ts's preserveOrder walk of
// word/document.xml (the body object model's cross-tag ordering recovery) —
// same "source XML itself doesn't parse, or an ordered node fails
// ObjectBlobNodeSchema" scope as the codes above, never a downstream
// capture-code defect.
describe('ParserError — DOCX_BODY_ORDER_XML_INVALID code (#300)', () => {
  it('accepts DOCX_BODY_ORDER_XML_INVALID as a ParserErrorCode and preserves cause', () => {
    const cause = new Error('malformed body markup');
    const err = new ParserError('failed to order-parse word/document.xml', {
      code: 'DOCX_BODY_ORDER_XML_INVALID',
      cause,
    });
    expect(err.code).toBe('DOCX_BODY_ORDER_XML_INVALID');
    expect(err.cause).toBe(cause);
  });
});
