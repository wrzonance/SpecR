import path from 'node:path';
import { parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { ParserError } from './error.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { inferSectionMeta } from '../lib/infer-section.js';
import type { CsiTree, SecRef } from '../ast/types.js';
import type { SectionInference } from '../lib/infer-section.js';

export { parseSec, assertSecSafe } from './sec/index.js';
export type { ParsedSec } from './sec/index.js';
export { parseDocx, assertDocxSafe } from './docx/index.js';
export { ParserError } from './error.js';
export type { SectionInference } from '../lib/infer-section.js';

export interface ParseResult {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
  readonly sectionInference: SectionInference;
}

function applyInference(tree: CsiTree, inference: SectionInference): CsiTree {
  if (inference.method === 'metadata' || inference.confidence === 'none') return tree;
  return { ...tree, section: inference.inferredSection, title: inference.inferredTitle };
}

export async function parse(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.sec') {
    const text = decodeTextBuffer(buffer);
    const { tree, refs } = parseSec(text);
    const sectionInference = inferSectionMeta(tree);
    return { tree: applyInference(tree, sectionInference), refs, sectionInference };
  }
  if (ext === '.docx') {
    const noop = (_stage: string, _pct: number): void => {};
    const tree = await parseDocx(buffer, noop);
    const sectionInference = inferSectionMeta(tree);
    return { tree: applyInference(tree, sectionInference), refs: [], sectionInference };
  }
  throw new ParserError(`unsupported format: ${ext}`);
}
