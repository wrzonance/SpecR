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
    expect(result.sectionInference.method).toBe('metadata');
    expect(result.sectionInference.inferredSection).toBe('27 10 00');
  });

  it('dispatches .docx to parseDocx', async () => {
    vi.mocked(parseDocx).mockResolvedValue(mockTree);
    const buf = Buffer.from('PK...');
    const result = await parse(buf, 'spec.docx');
    expect(parseDocx).toHaveBeenCalledWith(buf, expect.any(Function));
    expect(result.tree).toBe(mockTree);
    expect(result.refs).toEqual([]);
    expect(result.sectionInference.method).toBe('metadata');
  });

  it('is case-insensitive for extension', async () => {
    vi.mocked(parseSec).mockReturnValue({ tree: mockTree, refs: [] });
    const result = await parse(Buffer.from(''), 'SPEC.SEC');
    expect(parseSec).toHaveBeenCalled();
    expect(result.sectionInference).toBeDefined();
  });

  it('throws ParserError for unsupported extension', async () => {
    await expect(parse(Buffer.from(''), 'spec.pdf')).rejects.toBeInstanceOf(ParserError);
  });

  it('updates tree section and title when inference fires on unknown section', async () => {
    const unknownTree: CsiTree = {
      id: 'x',
      section: 'unknown',
      title: 'unknown',
      parts: [
        { id: 'n1', type: 'part', text: 'SECTION 26 09 33', children: [], meta: {} },
        { id: 'n2', type: 'part', text: 'MOTOR CONTROLLERS', children: [], meta: {} },
      ],
    };
    vi.mocked(parseSec).mockReturnValue({ tree: unknownTree, refs: [] });
    const result = await parse(Buffer.from(''), 'spec.sec');
    expect(result.tree.section).toBe('26 09 33');
    expect(result.tree.title).toBe('MOTOR CONTROLLERS');
    expect(result.sectionInference.method).toBe('content-high');
    expect(result.sectionInference.confidence).toBe('high');
  });
});
