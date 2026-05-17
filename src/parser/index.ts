import path from 'node:path';
import { parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { ParserError } from './error.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import type { CsiTree, SecRef } from '../ast/types.js';

export { parseSec, assertSecSafe } from './sec/index.js';
export type { ParsedSec } from './sec/index.js';
export { parseDocx, assertDocxSafe } from './docx/index.js';
export { ParserError } from './error.js';

export interface ParseResult {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
}

export async function parse(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.sec') {
    const text = decodeTextBuffer(buffer);
    return parseSec(text);
  }
  if (ext === '.docx') {
    const noop = (_stage: string, _pct: number): void => {};
    const tree = await parseDocx(buffer, noop);
    return { tree, refs: [] };
  }
  throw new ParserError(`unsupported format: ${ext}`);
}
