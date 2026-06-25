import { describe, expect, it } from 'vitest';
import { extractPdfText, type PdfExtractorDependencies } from './extract.js';
import { normalizePdfText } from './normalize.js';

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

function textPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
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

function textStream(lines: readonly string[], y: number): string {
  const escaped = lines.map((line) =>
    line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  );
  const textOps = escaped.map((line) => `(${line}) Tj T*`).join(' ');
  return `BT /F1 12 Tf 20 TL 72 ${y} Td ${textOps} ET`;
}

function a4TwoPagePdf(): Buffer {
  const firstStream = textStream(['SpecR Header', 'PART 1 - GENERAL', '1.1 SUMMARY'], 820);
  const secondStream = textStream(['SpecR Header', 'PART 2 - PRODUCTS', '2.1 MATERIALS'], 820);
  return buildPdf([
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'),
    pdfObject(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>'
    ),
    pdfObject(
      4,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>'
    ),
    pdfObject(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    pdfObject(
      6,
      `<< /Length ${Buffer.byteLength(firstStream, 'utf-8')} >>\nstream\n${firstStream}\nendstream`
    ),
    pdfObject(
      7,
      `<< /Length ${Buffer.byteLength(secondStream, 'utf-8')} >>\nstream\n${secondStream}\nendstream`
    ),
  ]);
}

function blankPdf(): Buffer {
  return buildPdf([
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>'),
  ]);
}

describe('extractPdfText', () => {
  it('extracts per-page text and positioned items from a text-layer PDF', async () => {
    const result = await extractPdfText(textPdf('SECTION 03 30 00 - CAST-IN-PLACE CONCRETE'));

    expect(result.text).toContain('SECTION 03 30 00');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.items.some((item) => item.str.includes('SECTION'))).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('falls back to pdfjs-dist and emits a degraded warning when the primary extractor fails', async () => {
    const deps: Partial<PdfExtractorDependencies> = {
      extractText: () => {
        throw new Error('primary failed');
      },
    };

    const result = await extractPdfText(textPdf('PART 1 - GENERAL'), deps);

    expect(result.text).toContain('PART 1');
    expect(result.warnings.some((warning) => warning.type === 'pdf-degraded-extraction')).toBe(
      true
    );
  });

  it('returns an empty text layer for a no-text PDF without crashing', async () => {
    const result = await extractPdfText(blankPdf());

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.text).toBe('');
  });

  it('keeps real A4 page dimensions on the primary path so repeated furniture is stripped', async () => {
    const result = await extractPdfText(a4TwoPagePdf());

    expect(result.pages.map((page) => page.height)).toEqual([842, 842]);
    expect(normalizePdfText(result.pages)).toBe(
      ['PART 1 - GENERAL', '1.1 SUMMARY', 'PART 2 - PRODUCTS', '2.1 MATERIALS'].join('\n')
    );
  });
});
