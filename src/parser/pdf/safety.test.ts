import { describe, expect, it } from 'vitest';
import { ParserError } from '../error.js';
import { assertPdfSafe } from './safety.js';

describe('assertPdfSafe', () => {
  it('accepts a buffer with a PDF magic signature', () => {
    expect(() => assertPdfSafe(Buffer.from('%PDF-1.7\n', 'utf-8'))).not.toThrow();
  });

  it('rejects a buffer without a PDF magic signature', () => {
    expect(() => assertPdfSafe(Buffer.from('not a pdf', 'utf-8'))).toThrow(ParserError);
    expect(() => assertPdfSafe(Buffer.from('not a pdf', 'utf-8'))).toThrow(
      'invalid PDF: missing %PDF- signature'
    );
  });

  it('rejects a PDF buffer over the parser safety limit', () => {
    const oversized = Buffer.concat([Buffer.from('%PDF-', 'utf-8'), Buffer.alloc(10_485_761)]);

    expect(() => assertPdfSafe(oversized)).toThrow('PDF exceeds 10 MB safety limit');
  });
});
