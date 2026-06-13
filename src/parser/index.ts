import path from 'node:path';
import { assertSecSafe, parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { parseText } from './text/index.js';
import { extractRefsFromTree } from './refs/index.js';
import { ParserError } from './error.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { inferSectionMeta } from '../lib/infer-section.js';
import type { SpecTree, SecRef } from '../ast/types.js';
import type { SectionInference } from '../lib/infer-section.js';

export { parseSec, assertSecSafe } from './sec/index.js';
export type { ParsedSec } from './sec/index.js';
export { parseDocx, assertDocxSafe, analyzeDocxStyles, deriveTemplate } from './docx/index.js';
export type {
  DocxStyleAnalysis,
  DerivedTemplate,
  DerivedRule,
  DerivationReport,
  NodeTypeReport,
  PropertyDecision,
} from './docx/index.js';
export { parseText } from './text/index.js';
export { extractRefsFromTree } from './refs/index.js';
export { ParserError } from './error.js';
export type { SectionInference } from '../lib/infer-section.js';

export interface ParseResult {
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
  readonly sectionInference: SectionInference;
  readonly capabilities?: readonly string[];
}

function applyInference(tree: SpecTree, inference: SectionInference): SpecTree {
  if (inference.method === 'metadata' || inference.confidence === 'none') return tree;
  const section =
    inference.inferredSection !== 'unknown' ? inference.inferredSection : tree.section;
  const title = inference.inferredTitle !== 'unknown' ? inference.inferredTitle : tree.title;
  if (section === tree.section && title === tree.title) return tree;
  return { ...tree, section, title };
}

export async function parse(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.sec') {
    const text = assertSecSafe(buffer);
    const { tree, refs } = parseSec(text);
    const sectionInference = inferSectionMeta(tree);
    return { tree: applyInference(tree, sectionInference), refs, sectionInference };
  }
  if (ext === '.docx') {
    const noop = (_stage: string, _pct: number): void => {};
    const tree = await parseDocx(buffer, noop);
    const sectionInference = inferSectionMeta(tree);
    const finalTree = applyInference(tree, sectionInference);
    const refs = extractRefsFromTree(finalTree);
    return { tree: finalTree, refs, sectionInference };
  }
  if (ext === '.txt') {
    const text = decodeTextBuffer(buffer);
    const { tree, refs, capabilities } = parseText(text);
    const sectionInference = inferSectionMeta(tree);
    return { tree, refs, sectionInference, capabilities };
  }
  throw new ParserError(`unsupported format: ${ext}`);
}
