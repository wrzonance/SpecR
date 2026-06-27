import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Tesseract from 'tesseract.js';
import { definePDFJSModule, renderPageAsImage } from 'unpdf';
import { ParserError } from '../error.js';

export interface PdfOcrText {
  readonly pageNumber: number;
  readonly text: string;
  readonly confidence: number;
}

export interface PdfOcrRenderOptions {
  readonly scale: number;
}

export type PdfOcrPageRenderer = (
  data: Uint8Array,
  pageNumber: number,
  options: PdfOcrRenderOptions
) => Promise<ArrayBuffer | Buffer>;

export type PdfOcrRecognizer = (
  image: Buffer
) => Promise<{ readonly text: string; readonly confidence: number }>;

export interface PdfOcrOptions {
  readonly renderPageAsImage?: PdfOcrPageRenderer;
  readonly recognize?: PdfOcrRecognizer;
  readonly langPath?: string;
  readonly cachePath?: string;
  readonly language?: string;
  readonly scale?: number;
  /** Max ms to wait for the worker to initialize before degrading (see #298). */
  readonly initTimeoutMs?: number;
  /** DI seam for the worker factory — defaults to the real Tesseract factory. */
  readonly createWorker?: ManagedRecognizerFactory;
}

export interface ManagedRecognizer {
  readonly recognize: PdfOcrRecognizer;
  readonly terminate: () => Promise<void>;
}

export type ManagedRecognizerFactory = (options: PdfOcrOptions) => Promise<ManagedRecognizer>;

interface TesseractWorkerOptions {
  readonly workerBlobURL: boolean;
  readonly langPath?: string;
  readonly cachePath?: string;
}

const DEFAULT_OCR_LANGUAGE = 'eng';
const DEFAULT_RENDER_SCALE = 2;
const DEFAULT_OCR_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_PATH = path.join(tmpdir(), 'specr-tesseract');
let pdfJsModulePromise: Promise<void> | null = null;

function ensurePdfJsModule(): Promise<void> {
  pdfJsModulePromise ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
  return pdfJsModulePromise;
}

function pdfData(buffer: Buffer): Uint8Array {
  // Buffer already is a Uint8Array; return it directly rather than copying the
  // whole file on this hot fallback path. The caller (parsePdf) does not reuse
  // the buffer after OCR, so letting pdf.js consume it in place is safe.
  return buffer;
}

function tesseractOptions(options: PdfOcrOptions): TesseractWorkerOptions {
  return {
    workerBlobURL: false,
    ...(options.langPath !== undefined ? { langPath: options.langPath } : {}),
    cachePath: options.cachePath ?? DEFAULT_CACHE_PATH,
  };
}

async function defaultRenderPageAsImage(
  data: Uint8Array,
  pageNumber: number,
  options: PdfOcrRenderOptions
): Promise<ArrayBuffer> {
  await ensurePdfJsModule();
  return renderPageAsImage(data, pageNumber, {
    scale: options.scale,
    canvasImport: () => import('@napi-rs/canvas'),
  });
}

async function createManagedRecognizer(options: PdfOcrOptions): Promise<ManagedRecognizer> {
  await mkdir(options.cachePath ?? DEFAULT_CACHE_PATH, { recursive: true });
  const worker = await Tesseract.createWorker(
    options.language ?? DEFAULT_OCR_LANGUAGE,
    1,
    tesseractOptions(options)
  );
  return {
    recognize: async (image) => {
      const result = await worker.recognize(image);
      return { text: result.data.text, confidence: result.data.confidence };
    },
    terminate: async () => {
      await worker.terminate();
    },
  };
}

function terminateLater(init: Promise<ManagedRecognizer>): void {
  // The factory lost the race against the init timeout but may still resolve
  // later (a stalled CDN fetch can eventually complete). Terminate the worker so
  // a timed-out attempt never leaks a Tesseract worker process. A late rejection
  // is already covered by the timeout degradation, so swallow it.
  void init.then(
    (managed) => managed.terminate().catch(() => undefined),
    () => undefined
  );
}

// Bound worker initialization: when traineddata is uncached AND OCR_LANG_PATH is
// unset, tesseract.js fetches eng.traineddata from a CDN; a connection that is
// accepted but never answered would otherwise hang the parse job indefinitely
// (#298). Race the factory against a timer and surface a typed ParserError so
// parsePdf degrades to a `pdf-ocr-unusable` warning instead of stalling. Any
// factory rejection (the #290 fail-fast) is wrapped here as well.
async function initManagedRecognizer(options: PdfOcrOptions): Promise<ManagedRecognizer> {
  const factory = options.createWorker ?? createManagedRecognizer;
  const timeoutMs = options.initTimeoutMs ?? DEFAULT_OCR_INIT_TIMEOUT_MS;
  const init = factory(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      terminateLater(init);
      reject(new ParserError(`OCR worker init exceeded ${timeoutMs}ms timeout`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([init, timeout]);
  } catch (err) {
    if (err instanceof ParserError) throw err;
    throw new ParserError('failed to initialize OCR worker', { cause: err });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function imageBuffer(image: ArrayBuffer | Buffer): Buffer {
  return Buffer.isBuffer(image) ? image : Buffer.from(new Uint8Array(image));
}

async function withRecognizer<T>(
  options: PdfOcrOptions,
  fn: (recognizer: PdfOcrRecognizer) => Promise<T>
): Promise<T> {
  if (options.recognize !== undefined) return fn(options.recognize);
  const managed = await initManagedRecognizer(options);
  try {
    return await fn(managed.recognize);
  } finally {
    await managed.terminate();
  }
}

async function recognizePage(
  data: Uint8Array,
  pageNumber: number,
  renderer: PdfOcrPageRenderer,
  recognizer: PdfOcrRecognizer,
  scale: number
): Promise<PdfOcrText> {
  try {
    const image = await renderer(data, pageNumber, { scale });
    const result = await recognizer(imageBuffer(image));
    return { pageNumber, text: result.text, confidence: result.confidence };
  } catch (err) {
    throw new ParserError(`failed to OCR page ${pageNumber}`, { cause: err });
  }
}

export async function recognizePdfPages(
  buffer: Buffer,
  pageNumbers: readonly number[],
  options: PdfOcrOptions = {}
): Promise<readonly PdfOcrText[]> {
  const data = pdfData(buffer);
  const renderer = options.renderPageAsImage ?? defaultRenderPageAsImage;
  const scale = options.scale ?? DEFAULT_RENDER_SCALE;
  return withRecognizer(options, async (recognizer) => {
    const pages: PdfOcrText[] = [];
    for (const pageNumber of pageNumbers) {
      pages.push(await recognizePage(data, pageNumber, renderer, recognizer, scale));
    }
    return pages;
  });
}
