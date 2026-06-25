import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Tesseract from 'tesseract.js';
import { definePDFJSModule, renderPageAsImage } from 'unpdf';

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
}

interface ManagedRecognizer {
  readonly recognize: PdfOcrRecognizer;
  readonly terminate: () => Promise<void>;
}

interface TesseractWorkerOptions {
  readonly workerBlobURL: boolean;
  readonly langPath?: string;
  readonly cachePath?: string;
}

const DEFAULT_OCR_LANGUAGE = 'eng';
const DEFAULT_RENDER_SCALE = 2;
const DEFAULT_CACHE_PATH = path.join(tmpdir(), 'specr-tesseract');
let pdfJsModulePromise: Promise<void> | null = null;

function ensurePdfJsModule(): Promise<void> {
  pdfJsModulePromise ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
  return pdfJsModulePromise;
}

function pdfData(buffer: Buffer): Uint8Array {
  return Uint8Array.from(buffer);
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

function imageBuffer(image: ArrayBuffer | Buffer): Buffer {
  return Buffer.isBuffer(image) ? image : Buffer.from(new Uint8Array(image));
}

async function withRecognizer<T>(
  options: PdfOcrOptions,
  fn: (recognizer: PdfOcrRecognizer) => Promise<T>
): Promise<T> {
  if (options.recognize !== undefined) return fn(options.recognize);
  const managed = await createManagedRecognizer(options);
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
  const image = await renderer(data, pageNumber, { scale });
  const result = await recognizer(imageBuffer(image));
  return { pageNumber, text: result.text, confidence: result.confidence };
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
