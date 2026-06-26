import type { ParseWarning } from '../../ast/types.js';
import { parseText } from '../text/index.js';
import { warningSuggestionFor } from '../text/index.js';
import { extractPdfText } from './extract.js';
import type { PdfExtractionResult } from './extract.js';
import { recoverPdfFontEncoding } from './font-encoding.js';
import { normalizePdfText, type PdfPageText, type PdfTextItem } from './normalize.js';
import { recognizePdfPages, type PdfOcrOptions, type PdfOcrText } from './ocr.js';

export { assertPdfSafe } from './safety.js';

type PdfOcrStatus = 'none' | 'scanned' | 'mixed';
type PdfTextExtractor = (buffer: Buffer) => Promise<PdfExtractionResult>;
const DEFAULT_OCR_MIN_CHARS_PER_PAGE = 16;
const DEFAULT_OCR_LOW_CONFIDENCE_THRESHOLD = 70;
const OCR_LINE_X = 72;
const OCR_FIRST_LINE_Y_OFFSET = 72;
const OCR_LINE_HEIGHT = 16;
const OCR_CHAR_WIDTH = 6;

export interface PdfOcrNeed {
  readonly status: PdfOcrStatus;
  readonly pageNumbers: readonly number[];
}

export interface ParsePdfOptions {
  readonly ocrMinCharsPerPage?: number;
  readonly ocrLowConfidenceThreshold?: number;
  readonly extractPdfText?: PdfTextExtractor;
  readonly ocr?: PdfOcrOptions;
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

function pageList(pageNumbers: readonly number[]): string {
  return pageNumbers.length === 1 ? `page ${pageNumbers[0]}` : `pages ${pageNumbers.join(', ')}`;
}

function ocrLineHint(need: PdfOcrNeed, minCharsPerPage: number): string {
  const pages = need.status === 'scanned' ? 'all pages' : `pages ${need.pageNumbers.join(', ')}`;
  return `${pages} below ${minCharsPerPage} non-whitespace text-layer chars`;
}

function pdfWarning(type: ParseWarning['type'], lineHint: string): ParseWarning {
  return { type, lineHint, suggestion: warningSuggestionFor(type) };
}

function meanConfidence(results: readonly PdfOcrText[]): number {
  if (results.length === 0) return 0;
  const total = results.reduce((sum, result) => sum + result.confidence, 0);
  return total / results.length;
}

function usableOcrResults(results: readonly PdfOcrText[]): readonly PdfOcrText[] {
  return results.filter((result) => result.text.trim() !== '');
}

function unusableOcrPages(
  requestedPages: readonly number[],
  usableResults: readonly PdfOcrText[]
): readonly number[] {
  const usable = new Set(usableResults.map((result) => result.pageNumber));
  return requestedPages.filter((pageNumber) => !usable.has(pageNumber));
}

function ocrWarnings(
  need: PdfOcrNeed,
  results: readonly PdfOcrText[],
  minCharsPerPage: number,
  lowConfidenceThreshold: number
): readonly ParseWarning[] {
  const usableResults = usableOcrResults(results);
  const missingPages = unusableOcrPages(need.pageNumbers, usableResults);
  const warnings: ParseWarning[] = [];
  if (usableResults.length > 0) {
    warnings.push(pdfWarning('pdf-ocr-applied', ocrLineHint(need, minCharsPerPage)));
  }
  if (meanConfidence(usableResults) < lowConfidenceThreshold && usableResults.length > 0) {
    warnings.push(
      pdfWarning(
        'pdf-ocr-low-confidence',
        `${pageList(usableResults.map((result) => result.pageNumber))} mean OCR confidence ${meanConfidence(usableResults).toFixed(1)} below ${lowConfidenceThreshold}`
      )
    );
  }
  if (missingPages.length > 0) {
    warnings.push(pdfWarning('pdf-ocr-unusable', `${pageList(missingPages)} yielded no OCR text`));
  }
  return warnings;
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

function ocrItems(page: PdfPageText, text: string): readonly PdfTextItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => ({
      str: line,
      x: OCR_LINE_X,
      y: page.height - OCR_FIRST_LINE_Y_OFFSET - index * OCR_LINE_HEIGHT,
      width: line.length * OCR_CHAR_WIDTH,
      height: 12,
      hasEOL: true,
    }));
}

function spliceOcrText(
  pages: readonly PdfPageText[],
  results: readonly PdfOcrText[]
): readonly PdfPageText[] {
  const byPage = new Map(results.map((result) => [result.pageNumber, result]));
  return pages.map((page) => {
    const ocr = byPage.get(page.pageNumber);
    if (ocr === undefined || ocr.text.trim() === '') return page;
    return { ...page, text: ocr.text, items: ocrItems(page, ocr.text) };
  });
}

async function applyOcrIfNeeded(
  buffer: Buffer,
  pages: readonly PdfPageText[],
  need: PdfOcrNeed,
  options: ParsePdfOptions,
  minCharsPerPage: number
): Promise<{ readonly pages: readonly PdfPageText[]; readonly warnings: readonly ParseWarning[] }> {
  if (need.status === 'none') return { pages, warnings: [] };
  try {
    const results = await recognizePdfPages(buffer, need.pageNumbers, options.ocr);
    return {
      pages: spliceOcrText(pages, results),
      warnings: ocrWarnings(
        need,
        results,
        minCharsPerPage,
        options.ocrLowConfidenceThreshold ?? DEFAULT_OCR_LOW_CONFIDENCE_THRESHOLD
      ),
    };
  } catch {
    // OCR is a best-effort fallback: surface a generic warning instead of the raw
    // error. Tesseract/render failures commonly carry cache/lang filesystem paths,
    // which must not leak to API callers (CLAUDE.md: stack traces never leave the
    // process). recognizePdfPages already wraps the cause in a typed ParserError.
    return {
      pages,
      warnings: [pdfWarning('pdf-ocr-unusable', ocrLineHint(need, minCharsPerPage))],
    };
  }
}

export async function parsePdf(buffer: Buffer, options: ParsePdfOptions = {}) {
  const extractor = options.extractPdfText ?? extractPdfText;
  const minChars = options.ocrMinCharsPerPage ?? DEFAULT_OCR_MIN_CHARS_PER_PAGE;
  const extracted = await extractor(buffer);
  const recovered = recoverPdfFontEncoding(extracted.pages);
  const need = detectPdfOcrNeed(recovered.pages, minChars);
  const ocr = await applyOcrIfNeeded(buffer, recovered.pages, need, options, minChars);
  const normalized = normalizePdfText(ocr.pages);
  const parsed = parseText(normalized);
  const warnings = mergeWarnings(
    extracted.warnings,
    [...recovered.warnings, ...ocr.warnings],
    parsed.tree.warnings
  );
  const tree = warnings.length > 0 ? { ...parsed.tree, warnings } : parsed.tree;
  return {
    tree,
    refs: parsed.refs,
    capabilities: capabilitiesWithWarnings(parsed.capabilities, warnings),
  };
}
