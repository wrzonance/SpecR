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
