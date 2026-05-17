import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./sec/index.js', () => ({
  parseSec: vi.fn(),
  assertSecSafe: vi.fn(),
}));
vi.mock('./docx/index.js', () => ({
  parseDocx: vi.fn(),
  assertDocxSafe: vi.fn(),
}));
vi.mock('../lib/decode-text.js', () => ({
  decodeTextBuffer: vi.fn((buf: Buffer) => buf.toString('utf-8')),
}));

import { parse } from './index.js';
import { parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { ParserError } from './error.js';
import type { CsiTree } from '../ast/types.js';

const mockTree: CsiTree = { id: 'spec-1', section: '27 10 00', title: 'Test', parts: [] };

beforeEach(() => vi.clearAllMocks());

describe('parse() dispatcher', () => {
  it('dispatches .sec to parseSec via decodeTextBuffer', async () => {
    vi.mocked(parseSec).mockReturnValue({ tree: mockTree, refs: [] });
    const buf = Buffer.from('<SEC/>');
    const result = await parse(buf, 'spec.SEC');
    expect(decodeTextBuffer).toHaveBeenCalledWith(buf);
    expect(parseSec).toHaveBeenCalled();
    expect(result.tree).toBe(mockTree);
    expect(result.refs).toEqual([]);
  });

  it('dispatches .docx to parseDocx', async () => {
    vi.mocked(parseDocx).mockResolvedValue(mockTree);
    const buf = Buffer.from('PK...');
    const result = await parse(buf, 'spec.docx');
    expect(parseDocx).toHaveBeenCalledWith(buf, expect.any(Function));
    expect(result.tree).toBe(mockTree);
    expect(result.refs).toEqual([]);
  });

  it('is case-insensitive for extension', async () => {
    vi.mocked(parseSec).mockReturnValue({ tree: mockTree, refs: [] });
    await parse(Buffer.from(''), 'SPEC.SEC');
    expect(parseSec).toHaveBeenCalled();
  });

  it('throws ParserError for unsupported extension', async () => {
    await expect(parse(Buffer.from(''), 'spec.pdf')).rejects.toBeInstanceOf(ParserError);
  });
});
