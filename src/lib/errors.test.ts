import { describe, it, expect } from 'vitest';
import { SpecrError } from './errors.js';
import { ParserError } from '../parser/error.js';

describe('error codes', () => {
  it('SpecrError carries an optional machine-branchable code', () => {
    const e = new SpecrError('boom', { code: 'X' });
    expect(e.code).toBe('X');
    expect(e.name).toBe('SpecrError');
  });
  it('ParserError narrows code and chains cause', () => {
    const cause = new Error('root');
    const e = new ParserError('bad docx', { code: 'DOCX_NO_PARAGRAPHS', cause });
    expect(e.code).toBe('DOCX_NO_PARAGRAPHS');
    expect(e.cause).toBe(cause);
  });
});
