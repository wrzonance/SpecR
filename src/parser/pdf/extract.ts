import { definePDFJSModule, extractText, extractTextItems, type StructuredTextItem } from 'unpdf';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';
import type { ParseWarning } from '../../ast/types.js';
import { ParserError } from '../error.js';
import { warningSuggestionFor } from '../text/index.js';
import type { PdfPageText, PdfTextItem } from './normalize.js';

export interface PdfExtractionResult {
  readonly text: string;
  readonly pages: readonly PdfPageText[];
  readonly warnings: readonly ParseWarning[];
}

export interface PdfExtractorDependencies {
  readonly extractText: typeof extractText;
  readonly extractTextItems: typeof extractTextItems;
  readonly getDocument: typeof getDocument;
}

const PdfJsTextItemSchema = z.object({
  str: z.string(),
  transform: z.array(z.unknown()),
  width: z.number(),
  height: z.number(),
  hasEOL: z.boolean(),
});

type PdfJsTextItem = z.infer<typeof PdfJsTextItemSchema>;

const DEFAULT_PAGE_WIDTH = 612;
const DEFAULT_PAGE_HEIGHT = 792;
const THIN_EXTRACTION_CHARS = 16;
let pdfJsModulePromise: Promise<void> | null = null;

function ensurePdfJsModule(): Promise<void> {
  pdfJsModulePromise ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
  return pdfJsModulePromise;
}

function depsWithDefaults(deps?: Partial<PdfExtractorDependencies>): PdfExtractorDependencies {
  return {
    extractText: deps?.extractText ?? extractText,
    extractTextItems: deps?.extractTextItems ?? extractTextItems,
    getDocument: deps?.getDocument ?? getDocument,
  };
}

function pdfData(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer;
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s/g, '').length;
}

function isThinExtraction(result: PdfExtractionResult): boolean {
  return nonWhitespaceLength(result.text) < THIN_EXTRACTION_CHARS;
}

function degradedWarning(reason: string): ParseWarning {
  return {
    type: 'pdf-degraded-extraction',
    lineHint: reason,
    suggestion: warningSuggestionFor('pdf-degraded-extraction'),
  };
}

function mergePageText(pages: readonly PdfPageText[]): string {
  return pages.map((page) => page.text).join('\n');
}

function mapStructuredItem(item: StructuredTextItem): PdfTextItem {
  return {
    str: item.str,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    hasEOL: item.hasEOL,
  };
}

async function extractPrimary(
  buffer: Buffer,
  deps: PdfExtractorDependencies
): Promise<PdfExtractionResult> {
  await ensurePdfJsModule();
  const [textResult, itemResult] = await Promise.all([
    deps.extractText(pdfData(buffer), { mergePages: false }),
    deps.extractTextItems(pdfData(buffer)),
  ]);
  const pages = textResult.text.map((text, index) => ({
    pageNumber: index + 1,
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
    text,
    items: (itemResult.items[index] ?? []).map(mapStructuredItem),
  }));
  return { text: pages.map((page) => page.text).join('\n'), pages, warnings: [] };
}

function mapContentItem(item: unknown): readonly PdfTextItem[] {
  const parsed = PdfJsTextItemSchema.safeParse(item);
  return parsed.success ? [mapPdfJsItem(parsed.data)] : [];
}

function transformNumber(transform: readonly unknown[], index: number): number {
  const value = transform[index];
  return typeof value === 'number' ? value : 0;
}

function mapPdfJsItem(item: PdfJsTextItem): PdfTextItem {
  return {
    str: item.str,
    x: transformNumber(item.transform, 4),
    y: transformNumber(item.transform, 5),
    width: item.width,
    height: item.height,
    hasEOL: item.hasEOL,
  };
}

async function fallbackPages(pdf: PDFDocumentProxy): Promise<readonly PdfPageText[]> {
  const pages: PdfPageText[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.flatMap(mapContentItem);
    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      text: items
        .map((item) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      items,
    });
  }
  return pages;
}

async function extractFallback(
  data: ArrayBuffer,
  deps: PdfExtractorDependencies
): Promise<PdfExtractionResult> {
  await ensurePdfJsModule();
  const task = deps.getDocument({ data, stopAtErrors: false, disableFontFace: true });
  try {
    const pdf = await task.promise;
    const pages = await fallbackPages(pdf);
    return { text: mergePageText(pages), pages, warnings: [] };
  } finally {
    await task.destroy();
  }
}

async function fallbackAfterPrimary(
  buffer: Buffer,
  deps: PdfExtractorDependencies,
  primary: PdfExtractionResult
): Promise<PdfExtractionResult> {
  try {
    const fallback = await extractFallback(pdfData(buffer), deps);
    return { ...fallback, warnings: [degradedWarning('primary extractor returned sparse text')] };
  } catch {
    return { ...primary, warnings: [degradedWarning('primary extractor returned sparse text')] };
  }
}

export async function extractPdfText(
  buffer: Buffer,
  overrides?: Partial<PdfExtractorDependencies>
): Promise<PdfExtractionResult> {
  const deps = depsWithDefaults(overrides);
  try {
    const primary = await extractPrimary(buffer, deps);
    return isThinExtraction(primary) ? fallbackAfterPrimary(buffer, deps, primary) : primary;
  } catch (err) {
    try {
      const fallback = await extractFallback(pdfData(buffer), deps);
      return { ...fallback, warnings: [degradedWarning('primary extractor failed')] };
    } catch (fallbackErr) {
      throw new ParserError('failed to extract PDF text layer', { cause: fallbackErr ?? err });
    }
  }
}
