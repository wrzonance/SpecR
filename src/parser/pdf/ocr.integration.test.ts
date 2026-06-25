import { deflateSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { parsePdf } from './index.js';
import type { PdfOcrOptions } from './ocr.js';

const OCR_E2E_ENABLED = process.env['SPECR_OCR_E2E'] === '1';
const PAGE_WIDTH = 900;
const PAGE_HEIGHT = 260;

function pdfObject(id: number, body: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n`, 'ascii'),
    typeof body === 'string' ? Buffer.from(body, 'ascii') : body,
    Buffer.from('\nendobj\n', 'ascii'),
  ]);
}

function streamObject(id: number, dictionary: string, stream: Buffer): Buffer {
  return pdfObject(
    id,
    Buffer.concat([
      Buffer.from(`<< ${dictionary} /Length ${stream.length} >>\nstream\n`, 'ascii'),
      stream,
      Buffer.from('\nendstream', 'ascii'),
    ])
  );
}

function buildPdf(objects: readonly Buffer[]): Buffer {
  const header = Buffer.from('%PDF-1.4\n', 'ascii');
  const offsets: number[] = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((objectOffset) => `${objectOffset.toString().padStart(10, '0')} 00000 n `),
  ].join('\n');
  const trailer = `\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([header, ...objects, Buffer.from(xref + trailer, 'ascii')]);
}

function drawTextImage(text: string): Buffer {
  const canvas = createCanvas(PAGE_WIDTH, PAGE_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  ctx.fillStyle = 'black';
  ctx.font = '64px sans-serif';
  ctx.fillText(text, 48, 145);
  return rgbPixels(ctx.getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT).data);
}

function rgbPixels(rgba: Uint8ClampedArray): Buffer {
  const rgb = Buffer.alloc((rgba.length / 4) * 3);
  for (let src = 0, dst = 0; src < rgba.length; src += 4, dst += 3) {
    rgb[dst] = rgba[src] ?? 255;
    rgb[dst + 1] = rgba[src + 1] ?? 255;
    rgb[dst + 2] = rgba[src + 2] ?? 255;
  }
  return rgb;
}

function imageOnlyPdf(text: string): Buffer {
  const image = deflateSync(drawTextImage(text));
  const content = Buffer.from(`q\n${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm\n/Im1 Do\nQ\n`, 'ascii');
  return buildPdf([
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(
      3,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`
    ),
    streamObject(
      4,
      `/Type /XObject /Subtype /Image /Width ${PAGE_WIDTH} /Height ${PAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      image
    ),
    streamObject(5, '', content),
  ]);
}

function ocrOptionsFromEnv(): PdfOcrOptions {
  return {
    scale: 2,
    ...(process.env['OCR_LANG_PATH'] !== undefined
      ? { langPath: process.env['OCR_LANG_PATH'] }
      : {}),
    ...(process.env['OCR_CACHE_PATH'] !== undefined
      ? { cachePath: process.env['OCR_CACHE_PATH'] }
      : {}),
  };
}

describe.skipIf(!OCR_E2E_ENABLED)('parsePdf real OCR path', () => {
  it('recovers hierarchy text from an image-only PDF', async () => {
    const result = await parsePdf(imageOnlyPdf('PART 1 - GENERAL'), {
      ocrMinCharsPerPage: 16,
      ocr: ocrOptionsFromEnv(),
    });

    expect(result.tree.parts[0]?.text.toUpperCase()).toContain('GENERAL');
    expect(result.tree.warnings?.some((warning) => warning.type === 'pdf-ocr-applied')).toBe(true);
  }, 60_000);
});
