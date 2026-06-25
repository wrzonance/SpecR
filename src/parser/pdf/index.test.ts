import { describe, expect, it, vi } from 'vitest';
import { detectPdfOcrNeed, parsePdf } from './index.js';
import type { PdfExtractionResult } from './extract.js';

function pdfObject(id: number, body: string): string {
  return `${id} 0 obj\n${body}\nendobj\n`;
}

function buildPdf(objects: readonly string[]): Buffer {
  const header = '%PDF-1.4\n';
  const offsets: number[] = [0];
  let body = '';
  for (const object of objects) {
    offsets.push(Buffer.byteLength(header + body, 'utf-8'));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(header + body, 'utf-8');
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n `),
  ].join('\n');
  const trailer = `\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(`${header}${body}${xref}${trailer}`, 'utf-8');
}

function textLayerPdf(lines: readonly string[]): Buffer {
  const escaped = lines.map((line) =>
    line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  );
  const textOps = escaped.map((line) => `(${line}) Tj T*`).join(' ');
  const stream = `BT /F1 12 Tf 20 TL 72 720 Td ${textOps} ET`;
  return buildPdf([
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
    ),
    pdfObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    pdfObject(
      5,
      `<< /Length ${Buffer.byteLength(stream, 'utf-8')} >>\nstream\n${stream}\nendstream`
    ),
  ]);
}

function extractionResult(pageTexts: readonly string[]): PdfExtractionResult {
  return {
    text: pageTexts.join('\n'),
    warnings: [],
    pages: pageTexts.map((text, index) => ({
      pageNumber: index + 1,
      width: 612,
      height: 792,
      text,
      items: text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line, lineIndex) => ({
          str: line,
          x: 72,
          y: 720 - lineIndex * 20,
          width: line.length * 6,
          height: 12,
        })),
    })),
  };
}

function extractionResultWithoutItems(text: string): PdfExtractionResult {
  return {
    text,
    warnings: [],
    pages: [{ pageNumber: 1, width: 612, height: 792, text, items: [] }],
  };
}

function hasOcrWarning(result: Awaited<ReturnType<typeof parsePdf>>): boolean {
  return result.tree.warnings?.some((warning) => warning.type === 'pdf-needs-ocr') ?? false;
}

describe('detectPdfOcrNeed', () => {
  it('classifies a PDF as scanned when every page is below the text threshold', () => {
    expect(detectPdfOcrNeed(extractionResult(['', '   ']).pages, 16)).toEqual({
      status: 'scanned',
      pageNumbers: [1, 2],
    });
  });

  it('classifies a PDF as mixed when only some pages are below the text threshold', () => {
    const result = extractionResult(['SECTION 03 30 00 - CAST-IN-PLACE CONCRETE', '']);

    expect(detectPdfOcrNeed(result.pages, 16)).toEqual({
      status: 'mixed',
      pageNumbers: [2],
    });
  });

  it('classifies pages with extractor text but no positioned items as scanned', () => {
    const result = extractionResultWithoutItems('Text exists only in the merged extractor output');

    expect(detectPdfOcrNeed(result.pages, 16)).toEqual({
      status: 'scanned',
      pageNumbers: [1],
    });
  });
});

describe('parsePdf', () => {
  it('extracts a real text-layer PDF into the text hierarchy pipeline', async () => {
    const result = await parsePdf(
      textLayerPdf([
        'SECTION 03 30 00 - CAST-IN-PLACE CONCRETE',
        'PART 1 - GENERAL',
        '1.1 SCOPE',
        'Cast-in-place concrete work.',
      ]),
      { ocrMinCharsPerPage: 16 }
    );

    expect(result.tree.section).toBe('03 30 00');
    expect(result.tree.parts).toHaveLength(1);
  });

  it('routes text-layer PDFs through parseText hierarchy inference', async () => {
    const result = await parsePdf(Buffer.from('%PDF'), {
      ocrMinCharsPerPage: 16,
      extractPdfText: () =>
        Promise.resolve(
          extractionResult([
            [
              'SECTION 03 30 00 - CAST-IN-PLACE CONCRETE',
              'PART 1 - GENERAL',
              '1.1 SCOPE',
              'Cast-in-place concrete work.',
            ].join('\n'),
          ])
        ),
    });

    expect(result.tree.section).toBe('03 30 00');
    expect(result.tree.parts).toHaveLength(1);
    expect(result.tree.warnings?.some((warning) => warning.type === 'pdf-needs-ocr') ?? false).toBe(
      false
    );
  });

  it('uses the default OCR threshold without importing env and honors explicit thresholds', async () => {
    vi.doMock('../../lib/env.js', () => {
      throw new Error('parser PDF must not import env');
    });
    try {
      const sparse = extractionResult(['1234567890']);
      const defaultResult = await parsePdf(Buffer.from('%PDF'), {
        extractPdfText: () => Promise.resolve(sparse),
      });
      const explicitResult = await parsePdf(Buffer.from('%PDF'), {
        ocrMinCharsPerPage: 4,
        extractPdfText: () => Promise.resolve(sparse),
      });

      expect(hasOcrWarning(defaultResult)).toBe(true);
      expect(hasOcrWarning(explicitResult)).toBe(false);
    } finally {
      vi.doUnmock('../../lib/env.js');
    }
  });

  it('emits a needs-OCR warning when merged text has no usable positioned items', async () => {
    const result = await parsePdf(Buffer.from('%PDF'), {
      ocrMinCharsPerPage: 16,
      extractPdfText: () =>
        Promise.resolve(extractionResultWithoutItems('Text exists only outside positioned items')),
    });

    expect(hasOcrWarning(result)).toBe(true);
    expect(result.capabilities).toContain('parse-warnings');
  });

  it('emits a needs-OCR warning instead of crashing when no text layer is present', async () => {
    const result = await parsePdf(Buffer.from('%PDF'), {
      ocrMinCharsPerPage: 16,
      extractPdfText: () => Promise.resolve(extractionResult([''])),
    });

    expect(result.tree.warnings?.some((warning) => warning.type === 'pdf-needs-ocr')).toBe(true);
    expect(result.capabilities).toContain('parse-warnings');
  });

  it('preserves degraded extraction warnings from the extractor', async () => {
    const result = await parsePdf(Buffer.from('%PDF'), {
      ocrMinCharsPerPage: 16,
      extractPdfText: () =>
        Promise.resolve({
          ...extractionResult(['PART 1 - GENERAL']),
          warnings: [
            { type: 'pdf-degraded-extraction', suggestion: 'Fallback PDF extractor was used.' },
          ],
        }),
    });

    expect(
      result.tree.warnings?.some((warning) => warning.type === 'pdf-degraded-extraction')
    ).toBe(true);
    expect(result.capabilities).toContain('parse-warnings');
  });
});
