import path from 'node:path';
import { assertSecSafe, parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { parsePdf } from './pdf/index.js';
import type { ParsePdfOptions } from './pdf/index.js';
import { parseText } from './text/index.js';
import { extractRefsFromTree } from './refs/index.js';
import { ParserError } from './error.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { inferSectionMeta } from '../lib/infer-section.js';
import { tagArticleRoles } from '../ast/index.js';
import type { SpecTree, SecRef } from '../ast/types.js';
import type { SectionInference } from '../lib/infer-section.js';

export { parseSec, assertSecSafe } from './sec/index.js';
export type { ParsedSec } from './sec/index.js';
export {
  parseDocx,
  assertDocxSafe,
  analyzeDocxStyles,
  deriveTemplate,
  extractNumberingProfile,
} from './docx/index.js';
export type {
  DocxStyleAnalysis,
  DerivedTemplate,
  DerivedRule,
  DerivationReport,
  NodeTypeReport,
  PropertyDecision,
} from './docx/index.js';
export { parseText } from './text/index.js';
export { parsePdf, assertPdfSafe } from './pdf/index.js';
export { extractRefsFromTree } from './refs/index.js';
export { ParserError } from './error.js';
export type { SectionInference } from '../lib/infer-section.js';
export type { NumberingProfile, TierName } from '../ast/index.js';

export interface ParseResult {
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
  readonly sectionInference: SectionInference;
  readonly capabilities?: readonly string[];
}

export interface ParseOptions {
  readonly ocrMinCharsPerPage?: number;
  readonly ocrLowConfidenceThreshold?: number;
  readonly ocrLangPath?: string;
  readonly ocrCachePath?: string;
  readonly ocrRenderScale?: number;
  readonly ocrInitTimeoutMs?: number;
  readonly ocrRequireLocalTraineddata?: boolean;
}

function withArticleRoles(tree: SpecTree): SpecTree {
  const parts = tagArticleRoles(tree.parts);
  return parts === tree.parts ? tree : { ...tree, parts };
}

function applyInference(tree: SpecTree, inference: SectionInference): SpecTree {
  if (inference.method === 'metadata' || inference.confidence === 'none') return tree;
  const section =
    inference.inferredSection !== 'unknown' ? inference.inferredSection : tree.section;
  const title = inference.inferredTitle !== 'unknown' ? inference.inferredTitle : tree.title;
  if (section === tree.section && title === tree.title) return tree;
  return { ...tree, section, title };
}

function parseSecBuffer(buffer: Buffer): ParseResult {
  const text = assertSecSafe(buffer);
  const { tree, refs } = parseSec(text);
  const sectionInference = inferSectionMeta(tree);
  return {
    tree: withArticleRoles(applyInference(tree, sectionInference)),
    refs,
    sectionInference,
  };
}

async function parseDocxBuffer(buffer: Buffer): Promise<ParseResult> {
  const noop = (_stage: string, _pct: number): void => {};
  const tree = await parseDocx(buffer, noop);
  const sectionInference = inferSectionMeta(tree);
  const finalTree = withArticleRoles(applyInference(tree, sectionInference));
  return { tree: finalTree, refs: extractRefsFromTree(finalTree), sectionInference };
}

function parseTxtBuffer(buffer: Buffer): ParseResult {
  const text = decodeTextBuffer(buffer);
  const { tree, refs, capabilities } = parseText(text);
  const sectionInference = inferSectionMeta(tree);
  return { tree: withArticleRoles(tree), refs, sectionInference, capabilities };
}

function hasAnyOcrOption(options?: ParseOptions): boolean {
  return (
    options?.ocrLangPath !== undefined ||
    options?.ocrCachePath !== undefined ||
    options?.ocrRenderScale !== undefined ||
    options?.ocrInitTimeoutMs !== undefined ||
    options?.ocrRequireLocalTraineddata !== undefined
  );
}

function ocrOptionsFromParseOptions(options?: ParseOptions): ParsePdfOptions['ocr'] | undefined {
  if (options === undefined || !hasAnyOcrOption(options)) return undefined;
  return {
    ...(options.ocrLangPath !== undefined ? { langPath: options.ocrLangPath } : {}),
    ...(options.ocrCachePath !== undefined ? { cachePath: options.ocrCachePath } : {}),
    ...(options.ocrRenderScale !== undefined ? { scale: options.ocrRenderScale } : {}),
    ...(options.ocrInitTimeoutMs !== undefined ? { initTimeoutMs: options.ocrInitTimeoutMs } : {}),
    ...(options.ocrRequireLocalTraineddata !== undefined
      ? { requireLocalTraineddata: options.ocrRequireLocalTraineddata }
      : {}),
  };
}

function pdfOptionsFromParseOptions(options?: ParseOptions): ParsePdfOptions {
  const ocr = ocrOptionsFromParseOptions(options);
  return {
    ...(options?.ocrMinCharsPerPage !== undefined
      ? { ocrMinCharsPerPage: options.ocrMinCharsPerPage }
      : {}),
    ...(options?.ocrLowConfidenceThreshold !== undefined
      ? { ocrLowConfidenceThreshold: options.ocrLowConfidenceThreshold }
      : {}),
    ...(ocr !== undefined ? { ocr } : {}),
  };
}

async function parsePdfBuffer(buffer: Buffer, options?: ParseOptions): Promise<ParseResult> {
  const { tree, refs, capabilities } = await parsePdf(buffer, pdfOptionsFromParseOptions(options));
  const sectionInference = inferSectionMeta(tree);
  return { tree: withArticleRoles(tree), refs, sectionInference, capabilities };
}

export async function parse(
  buffer: Buffer,
  filename: string,
  options?: ParseOptions
): Promise<ParseResult> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.sec') return parseSecBuffer(buffer);
  if (ext === '.docx') return parseDocxBuffer(buffer);
  if (ext === '.txt') return parseTxtBuffer(buffer);
  if (ext === '.pdf') return parsePdfBuffer(buffer, options);
  throw new ParserError(`unsupported format: ${ext}`);
}
