import type { ParseWarning } from '../../ast/types.js';
import { parseText } from '../text/index.js';
import { warningSuggestionFor } from '../text/index.js';
import { extractPdfText } from './extract.js';
import type { PdfExtractionResult } from './extract.js';
import { normalizePdfText, type PdfPageText } from './normalize.js';

export { assertPdfSafe } from './safety.js';

type PdfOcrStatus = 'none' | 'scanned' | 'mixed';
type PdfTextExtractor = (buffer: Buffer) => Promise<PdfExtractionResult>;
const DEFAULT_OCR_MIN_CHARS_PER_PAGE = 16;

export interface PdfOcrNeed {
  readonly status: PdfOcrStatus;
  readonly pageNumbers: readonly number[];
}

export interface ParsePdfOptions {
  readonly ocrMinCharsPerPage?: number;
  readonly extractPdfText?: PdfTextExtractor;
}

function pageChars(page: PdfPageText): number {
  return normalizePdfText([page]).replace(/\s/g, '').length;
}

export function detectPdfOcrNeed(
  pages: readonly PdfPageText[],
  minCharsPerPage: number
): PdfOcrNeed {
  const pageNumbers = pages
    .filter((page) => pageChars(page) < minCharsPerPage)
    .map((page) => page.pageNumber);
  if (pageNumbers.length === 0) return { status: 'none', pageNumbers: [] };
  return {
    status: pageNumbers.length === pages.length ? 'scanned' : 'mixed',
    pageNumbers,
  };
}

function ocrLineHint(need: PdfOcrNeed, minCharsPerPage: number): string {
  const pages = need.status === 'scanned' ? 'all pages' : `pages ${need.pageNumbers.join(', ')}`;
  return `${pages} below ${minCharsPerPage} non-whitespace text-layer chars`;
}

function ocrWarnings(need: PdfOcrNeed, minCharsPerPage: number): readonly ParseWarning[] {
  if (need.status === 'none') return [];
  return [
    {
      type: 'pdf-needs-ocr',
      lineHint: ocrLineHint(need, minCharsPerPage),
      suggestion: warningSuggestionFor('pdf-needs-ocr'),
    },
  ];
}

function mergeWarnings(
  extractionWarnings: readonly ParseWarning[],
  pdfWarnings: readonly ParseWarning[],
  textWarnings: readonly ParseWarning[] | undefined
): readonly ParseWarning[] {
  return [...extractionWarnings, ...pdfWarnings, ...(textWarnings ?? [])];
}

function capabilitiesWithWarnings(
  capabilities: readonly string[],
  warnings: readonly ParseWarning[]
): readonly string[] {
  const merged = new Set(capabilities);
  if (warnings.length > 0) merged.add('parse-warnings');
  return [...merged];
}

export async function parsePdf(buffer: Buffer, options: ParsePdfOptions = {}) {
  const extractor = options.extractPdfText ?? extractPdfText;
  const minChars = options.ocrMinCharsPerPage ?? DEFAULT_OCR_MIN_CHARS_PER_PAGE;
  const extracted = await extractor(buffer);
  const normalized = normalizePdfText(extracted.pages);
  const parsed = parseText(normalized);
  const need = detectPdfOcrNeed(extracted.pages, minChars);
  const warnings = mergeWarnings(
    extracted.warnings,
    ocrWarnings(need, minChars),
    parsed.tree.warnings
  );
  const tree = warnings.length > 0 ? { ...parsed.tree, warnings } : parsed.tree;
  return {
    tree,
    refs: parsed.refs,
    capabilities: capabilitiesWithWarnings(parsed.capabilities, warnings),
  };
}
