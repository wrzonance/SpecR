import { describe, expect, it } from 'vitest';
import { recoverPdfFontEncoding } from './font-encoding.js';
import { normalizePdfText, type PdfPageText, type PdfTextItem } from './normalize.js';

function item(str: string, x: number, y: number): PdfTextItem {
  return { str, x, y, width: str.length * 6, height: 12, hasEOL: true };
}

function page(text: string, items?: readonly PdfTextItem[]): PdfPageText {
  return {
    pageNumber: 1,
    width: 612,
    height: 792,
    text,
    items: items ?? text.split('\n').map((line, index) => item(line, 72, 720 - index * 20)),
  };
}

function warningTypes(result: ReturnType<typeof recoverPdfFontEncoding>): readonly string[] {
  return result.warnings.map((warning) => warning.type);
}

describe('recoverPdfFontEncoding', () => {
  it('rejects mojibake remaps that introduce replacement characters into valid symbols', () => {
    const source = [
      'SECTION 23 05 00 â€“ HVAC â€“ TEMPERATURE â€“ CONTROLS',
      'PART 1 â€“ GENERAL',
      '1.1 Maintain 70°F ± 2°F tolerance.',
    ].join('\n');

    const result = recoverPdfFontEncoding([page(source)]);
    const normalized = normalizePdfText(result.pages);

    expect(normalized).not.toContain('\uFFFD');
    expect(normalized).toContain('70°F ± 2°F');
    expect(warningTypes(result)).toContain('pdf-font-encoding-unrecoverable');
  });

  it('remaps adjacent split items as one text run without replacement characters', () => {
    const source = ['SECTION 03 30 00 â€” CAST-IN-PLACE CONCRETE', 'PART 1 â€” GENERAL'].join('\n');
    const result = recoverPdfFontEncoding([
      page(source, [
        item('SECTION 03 30 00 ', 72, 720),
        item('â', 180, 720),
        item('€”', 186, 720),
        item(' CAST-IN-PLACE CONCRETE', 198, 720),
        item('PART 1 ', 72, 700),
        item('â', 114, 700),
        item('€”', 120, 700),
        item(' GENERAL', 132, 700),
      ]),
    ]);

    const normalized = normalizePdfText(result.pages);

    expect(normalized).not.toContain('\uFFFD');
    expect(normalized).toContain('SECTION 03 30 00 — CAST-IN-PLACE CONCRETE');
    expect(normalized).toContain('PART 1 — GENERAL');
    expect(warningTypes(result)).toContain('pdf-font-encoding-remapped');
  });
});
