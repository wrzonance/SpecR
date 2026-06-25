import { describe, expect, it } from 'vitest';
import { normalizePdfText, type PdfPageText, type PdfTextItem } from './normalize.js';

function item(str: string, x: number, y: number): PdfTextItem {
  return { str, x, y, width: str.length * 6, height: 12, hasEOL: true };
}

function page(pageNumber: number, items: readonly PdfTextItem[]): PdfPageText {
  return { pageNumber, width: 612, height: 792, text: items.map((i) => i.str).join('\n'), items };
}

describe('normalizePdfText', () => {
  it('sorts positioned text into reading order and strips repeated page furniture', () => {
    const pages = [
      page(1, [
        item('Page 1', 280, 28),
        item('1.1 SCOPE', 72, 700),
        item('SpecR Header', 72, 770),
        item('PART 1 - GENERAL', 72, 724),
      ]),
      page(2, [
        item('Page 2', 280, 28),
        item('2.1 MATERIALS', 72, 700),
        item('PART 2 - PRODUCTS', 72, 724),
        item('SpecR Header', 72, 770),
      ]),
    ];

    expect(normalizePdfText(pages)).toBe(
      ['PART 1 - GENERAL', '1.1 SCOPE', 'PART 2 - PRODUCTS', '2.1 MATERIALS'].join('\n')
    );
  });

  it('repairs line-break hyphenation and removes soft hyphen characters', () => {
    const pages = [
      page(1, [item('A multi-', 72, 724), item('layer system includes soft\u00adware.', 72, 700)]),
    ];

    expect(normalizePdfText(pages)).toBe('A multilayer system includes software.');
  });

  it('orders two-column pages down the left column before the right column', () => {
    const pages = [
      page(1, [
        item('PART 2 - PRODUCTS', 330, 724),
        item('PART 1 - GENERAL', 72, 724),
        item('2.1 MATERIALS', 330, 700),
        item('1.1 SCOPE', 72, 700),
      ]),
    ];

    expect(normalizePdfText(pages)).toBe(
      ['PART 1 - GENERAL', '1.1 SCOPE', 'PART 2 - PRODUCTS', '2.1 MATERIALS'].join('\n')
    );
  });

  it('keeps one repeated SECTION header while stripping section-page footers', () => {
    const pages = [
      page(1, [
        item('SECTION 07 84 00 - FIRESTOPPING', 72, 770),
        item('PART 1 - GENERAL', 72, 724),
        item('1.1 SUMMARY', 72, 700),
        item('07 84 00-1', 280, 28),
      ]),
      page(2, [
        item('SECTION 07 84 00 - FIRESTOPPING', 72, 770),
        item('PART 2 - PRODUCTS', 72, 724),
        item('2.1 MATERIALS', 72, 700),
        item('07 84 00-2', 280, 28),
      ]),
    ];

    const normalized = normalizePdfText(pages);
    const lines = normalized.split('\n');

    expect(normalized).toBe(
      [
        'SECTION 07 84 00 - FIRESTOPPING',
        'PART 1 - GENERAL',
        '1.1 SUMMARY',
        'PART 2 - PRODUCTS',
        '2.1 MATERIALS',
      ].join('\n')
    );
    expect(lines.filter((line) => line === 'SECTION 07 84 00 - FIRESTOPPING')).toHaveLength(1);
    expect(lines).not.toContain('07 84 00-1');
    expect(lines).not.toContain('07 84 00-2');
  });
});
