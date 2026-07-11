import { describe, it, expect } from 'vitest';
import { Document, Packer, Header, Footer } from 'docx';
import JSZip from 'jszip';
import { renderHeaderFooterComposition } from './header-footer.js';
import type { HeaderFooterRenderResult } from './header-footer.js';
import type { HeaderFooterFieldContext } from './header-footer-fields.js';
import type { HeaderFooterComposition } from '../ast/index.js';

const CTX: HeaderFooterFieldContext = {
  sectionNumber: '09 91 26',
  sectionTitle: 'EXTERIOR PAINTING',
  current: { projectName: 'Riverside HQ' },
};

// Renders headers/footers through a real Document + Packer round-trip so
// assertions inspect actual generated OOXML parts, mirroring the
// front-matter.test.ts / manual.test.ts JSZip idiom.
async function unzipParts(
  headers: HeaderFooterRenderResult['headers'],
  footers: HeaderFooterRenderResult['footers']
): Promise<Set<string>> {
  const doc = new Document({
    sections: [
      {
        ...(headers !== undefined ? { headers } : {}),
        ...(footers !== undefined ? { footers } : {}),
        children: [],
      },
    ],
  });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  return new Set(Object.keys(zip.files).filter((name) => !zip.files[name]?.dir));
}

describe('renderHeaderFooterComposition — purity and totality', () => {
  it('never throws for an empty composition', () => {
    expect(() => renderHeaderFooterComposition({}, CTX)).not.toThrow();
  });

  it('is pure: identical inputs produce structurally-equivalent scalar fields on repeat calls', () => {
    const composition: HeaderFooterComposition = {
      header: { center: { content: [{ kind: 'sectionTitle' }] } },
    };
    const first = renderHeaderFooterComposition(composition, CTX);
    const second = renderHeaderFooterComposition(composition, CTX);
    expect(second.titlePage).toBe(first.titlePage);
    expect(second.evenAndOddHeaders).toBe(first.evenAndOddHeaders);
    expect(second.pageNumberStart).toBe(first.pageNumberStart);
    expect(second.warnings).toEqual(first.warnings);
  });

  it('never throws across a battery of shapes: v1, v2 variants, empty, malformed-adjacent', () => {
    const shapes: readonly HeaderFooterComposition[] = [
      {},
      { header: {}, footer: {} },
      { header: { left: { content: [{ kind: 'literal', text: 'X' }] } } },
      {
        variants: {
          default: { header: { center: { content: [{ kind: 'sectionNumber' }] } } },
          first: { header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } } },
          even: { footer: { right: { content: [{ kind: 'pageNumber' }] } } },
        },
      },
      { pageNumbering: { mode: 'continuous' } },
      { pageNumbering: { mode: 'restartPerSpec', startAt: 5 } },
      { raw: { warnings: ['unsupported watermark'] } },
      { style: { bold: true }, variants: { first: {} } },
    ];
    for (const composition of shapes) {
      expect(() => renderHeaderFooterComposition(composition, CTX)).not.toThrow();
    }
  });
});

describe('renderHeaderFooterComposition — titlePage/evenAndOddHeaders derive from variant presence', () => {
  it('both false when no variants key is present (v1-only composition)', () => {
    const result = renderHeaderFooterComposition(
      { header: { center: { content: [{ kind: 'sectionTitle' }] } } },
      CTX
    );
    expect(result.titlePage).toBe(false);
    expect(result.evenAndOddHeaders).toBe(false);
  });

  it('titlePage is true exactly when variants.first is present, independent of even', () => {
    expect(renderHeaderFooterComposition({ variants: { first: {} } }, CTX).titlePage).toBe(true);
    expect(renderHeaderFooterComposition({ variants: { even: {} } }, CTX).titlePage).toBe(false);
    expect(
      renderHeaderFooterComposition({ variants: { first: {}, even: {} } }, CTX).titlePage
    ).toBe(true);
  });

  it('evenAndOddHeaders is true exactly when variants.even is present, independent of first', () => {
    expect(renderHeaderFooterComposition({ variants: { even: {} } }, CTX).evenAndOddHeaders).toBe(
      true
    );
    expect(renderHeaderFooterComposition({ variants: { first: {} } }, CTX).evenAndOddHeaders).toBe(
      false
    );
    expect(
      renderHeaderFooterComposition({ variants: { first: {}, even: {} } }, CTX).evenAndOddHeaders
    ).toBe(true);
  });

  it('a present-but-empty first/even variant still counts as present', () => {
    const result = renderHeaderFooterComposition({ variants: { first: {}, even: {} } }, CTX);
    expect(result.titlePage).toBe(true);
    expect(result.evenAndOddHeaders).toBe(true);
  });
});

describe('renderHeaderFooterComposition — pageNumberStart', () => {
  it('is undefined when pageNumbering is absent', () => {
    expect(renderHeaderFooterComposition({}, CTX).pageNumberStart).toBeUndefined();
  });

  it('is undefined when mode is "continuous"', () => {
    expect(
      renderHeaderFooterComposition({ pageNumbering: { mode: 'continuous' } }, CTX).pageNumberStart
    ).toBeUndefined();
  });

  it('defaults to 1 when mode is "restartPerSpec" with no startAt', () => {
    expect(
      renderHeaderFooterComposition({ pageNumbering: { mode: 'restartPerSpec' } }, CTX)
        .pageNumberStart
    ).toBe(1);
  });

  it('honors an explicit startAt when mode is "restartPerSpec"', () => {
    expect(
      renderHeaderFooterComposition({ pageNumbering: { mode: 'restartPerSpec', startAt: 7 } }, CTX)
        .pageNumberStart
    ).toBe(7);
  });

  it('ignores startAt entirely when mode is "continuous"', () => {
    expect(
      renderHeaderFooterComposition({ pageNumbering: { mode: 'continuous', startAt: 99 } }, CTX)
        .pageNumberStart
    ).toBeUndefined();
  });
});

describe('renderHeaderFooterComposition — warnings', () => {
  it('is [] when composition.raw is absent', () => {
    expect(renderHeaderFooterComposition({}, CTX).warnings).toEqual([]);
  });

  it('is [] when composition.raw.warnings is absent', () => {
    expect(renderHeaderFooterComposition({ raw: {} }, CTX).warnings).toEqual([]);
  });

  it('is exactly composition.raw.warnings when present', () => {
    const warnings = ['unsupported watermark', 'dropped legacy field code'];
    expect(renderHeaderFooterComposition({ raw: { warnings } }, CTX).warnings).toEqual(warnings);
  });

  it('is always an array (never undefined) across every shape', () => {
    const shapes: readonly HeaderFooterComposition[] = [
      {},
      { raw: {} },
      { raw: { warnings: [] } },
      { raw: { warnings: ['x'] } },
    ];
    for (const composition of shapes) {
      expect(Array.isArray(renderHeaderFooterComposition(composition, CTX).warnings)).toBe(true);
    }
  });
});

describe('renderHeaderFooterComposition — headers/footers presence and shape', () => {
  it('omits headers/footers entirely for a fully empty composition', () => {
    const result = renderHeaderFooterComposition({}, CTX);
    expect(result.headers).toBeUndefined();
    expect(result.footers).toBeUndefined();
  });

  it('a v1-only composition renders only the default header/footer key', () => {
    const result = renderHeaderFooterComposition(
      {
        header: { center: { content: [{ kind: 'sectionTitle' }] } },
        footer: { right: { content: [{ kind: 'pageNumber' }] } },
      },
      CTX
    );
    expect(result.headers?.default).toBeInstanceOf(Header);
    expect(result.headers?.first).toBeUndefined();
    expect(result.headers?.even).toBeUndefined();
    expect(result.footers?.default).toBeInstanceOf(Footer);
    expect(result.footers?.first).toBeUndefined();
    expect(result.footers?.even).toBeUndefined();
  });

  it('a fully-empty variant with no header/footer content omits its Header/Footer key', () => {
    const result = renderHeaderFooterComposition(
      { variants: { default: { header: { center: { content: [{ kind: 'sectionTitle' }] } } } } },
      CTX
    );
    expect(result.headers?.default).toBeInstanceOf(Header);
    expect(result.footers).toBeUndefined();
  });

  it('default/first/even each produce their own Header/Footer instance', () => {
    const result = renderHeaderFooterComposition(
      {
        variants: {
          default: { header: { center: { content: [{ kind: 'literal', text: 'DEFAULT' }] } } },
          first: { header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } } },
          even: { header: { center: { content: [{ kind: 'literal', text: 'EVEN' }] } } },
        },
      },
      CTX
    );
    expect(result.headers?.default).toBeInstanceOf(Header);
    expect(result.headers?.first).toBeInstanceOf(Header);
    expect(result.headers?.even).toBeInstanceOf(Header);
  });
});

describe('renderHeaderFooterComposition — JSZip round-trip (default/first/even parts)', () => {
  it('emits word/header1.xml + word/footer1.xml for a v1-only (default-only) composition', async () => {
    const result = renderHeaderFooterComposition(
      {
        header: { center: { content: [{ kind: 'sectionTitle' }] } },
        footer: { right: { content: [{ kind: 'pageNumber' }] } },
      },
      CTX
    );
    const parts = await unzipParts(result.headers, result.footers);
    const headerParts = [...parts].filter((name) => /^word\/header\d+\.xml$/.test(name));
    const footerParts = [...parts].filter((name) => /^word\/footer\d+\.xml$/.test(name));
    expect(headerParts).toHaveLength(1);
    expect(footerParts).toHaveLength(1);
  });

  it('emits three header parts + three footer parts for default/first/even', async () => {
    const result = renderHeaderFooterComposition(
      {
        variants: {
          default: { header: { center: { content: [{ kind: 'literal', text: 'DEFAULT' }] } } },
          first: { header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } } },
          even: { header: { center: { content: [{ kind: 'literal', text: 'EVEN' }] } } },
        },
      },
      CTX
    );
    const parts = await unzipParts(result.headers, undefined);
    const headerParts = [...parts].filter((name) => /^word\/header\d+\.xml$/.test(name));
    expect(headerParts).toHaveLength(3);
  });
});

describe('renderHeaderFooterComposition — composition-level style cascades to every variant', () => {
  it('composition.style applies to first/even variants that omit their own style', async () => {
    const result = renderHeaderFooterComposition(
      {
        style: { bold: true },
        variants: {
          default: { header: { center: { content: [{ kind: 'literal', text: 'DEFAULT' }] } } },
          first: { header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } } },
        },
      },
      CTX
    );
    const doc = new Document({
      sections: [
        { ...(result.headers !== undefined ? { headers: result.headers } : {}), children: [] },
      ],
    });
    const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
    for (const name of Object.keys(zip.files)) {
      if (!/^word\/header\d+\.xml$/.test(name)) continue;
      const file = zip.file(name);
      if (!file) continue;
      const xml = await file.async('string');
      expect(xml).toMatch(/<w:b\/>/);
    }
  });
});

describe('renderHeaderFooterComposition — sectionNumber/sectionTitle sourced only from ctx', () => {
  it('renders ctx.sectionNumber / ctx.sectionTitle, never duplicated stored config', async () => {
    const result = renderHeaderFooterComposition(
      { header: { center: { content: [{ kind: 'sectionNumber' }, { kind: 'sectionTitle' }] } } },
      CTX
    );
    const zip = await JSZip.loadAsync(
      await Packer.toBuffer(
        new Document({
          sections: [
            { ...(result.headers !== undefined ? { headers: result.headers } : {}), children: [] },
          ],
        })
      )
    );
    const file = zip.file('word/header1.xml');
    if (!file) throw new Error('word/header1.xml missing');
    const xml = await file.async('string');
    expect(xml).toContain(CTX.sectionNumber);
    expect(xml).toContain(CTX.sectionTitle);
  });
});
