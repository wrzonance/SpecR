import { describe, it, expect } from 'vitest';
import { Document, Packer, Header, Footer } from 'docx';
import JSZip from 'jszip';
import { renderHeaderFooterComposition } from './header-footer.js';
import type { HeaderFooterRenderResult } from './header-footer.js';
import type { HeaderFooterFieldContext, HeaderFooterCell } from './header-footer-fields.js';
import type { HeaderFooterComposition } from '../ast/index.js';

const CTX: HeaderFooterFieldContext = {
  sectionNumber: '09 91 26',
  sectionTitle: 'EXTERIOR PAINTING',
  current: { projectName: 'Riverside HQ' },
};

// A minimal real PNG magic-byte signature (matches header-footer-images.test
// .ts's and header-footer-regions.test.ts's fixture) — `renderImageRun` only
// needs a signature `sniffImageMediaType` recognizes, not full pixel data.
const LOGO_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
]).toString('base64');

function imageCell(): HeaderFooterCell {
  return {
    content: [{ kind: 'image', imageData: LOGO_PNG_BASE64, widthEmu: 914400, heightEmu: 457200 }],
  };
}

// imageData present but no widthEmu/heightEmu — renderImageRun refuses to
// render this and imageFieldWarnings reports it (missingDimensionsWarning).
function brokenImageCell(): HeaderFooterCell {
  return { content: [{ kind: 'image', imageData: LOGO_PNG_BASE64 }] };
}

// Renders headers/footers through a real Document + Packer round-trip so
// assertions inspect actual generated OOXML parts, mirroring the
// front-matter.test.ts / manual.test.ts JSZip idiom.
function docWithHeadersFooters(
  headers: HeaderFooterRenderResult['headers'],
  footers: HeaderFooterRenderResult['footers']
): Document {
  return new Document({
    sections: [
      {
        ...(headers !== undefined ? { headers } : {}),
        ...(footers !== undefined ? { footers } : {}),
        children: [],
      },
    ],
  });
}

async function unzipParts(
  headers: HeaderFooterRenderResult['headers'],
  footers: HeaderFooterRenderResult['footers']
): Promise<Set<string>> {
  const zip = await JSZip.loadAsync(await Packer.toBuffer(docWithHeadersFooters(headers, footers)));
  return new Set(Object.keys(zip.files).filter((name) => !zip.files[name]?.dir));
}

// Extracts the rendered XML text of every word/header*.xml + word/footer*.xml
// part, keyed by part name — used to compare two renders' actual
// headers/footers *payload* (not just their presence) for structural
// equivalence, since `Header`/`Footer` are docx class instances that
// `toEqual` can't meaningfully diff on their own.
async function extractHeaderFooterXml(
  headers: HeaderFooterRenderResult['headers'],
  footers: HeaderFooterRenderResult['footers']
): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(await Packer.toBuffer(docWithHeadersFooters(headers, footers)));
  const names = Object.keys(zip.files).filter((name) =>
    /^word\/(header|footer)\d+\.xml$/.test(name)
  );
  const entries = await Promise.all(
    names.map(async (name) => {
      const file = zip.file(name);
      const xml = file === null ? '' : await file.async('string');
      return [name, xml] as const;
    })
  );
  return Object.fromEntries(entries);
}

// The `.rels` part (e.g. `word/_rels/header1.xml.rels`) for every rendered
// header/footer part, keyed by that part's own name — used to assert each
// page-variant instance gets its own relationship entry (not a sibling's)
// pointing at a shared media part, without asserting anything about `word/
// document.xml.rels` or other unrelated relationship parts.
async function extractHeaderFooterRels(
  headers: HeaderFooterRenderResult['headers'],
  footers: HeaderFooterRenderResult['footers']
): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(await Packer.toBuffer(docWithHeadersFooters(headers, footers)));
  const partNames = Object.keys(zip.files).filter((name) =>
    /^word\/(header|footer)\d+\.xml$/.test(name)
  );
  const entries = await Promise.all(
    partNames.map(async (partName) => {
      const relsName = partName.replace(/^word\/(.+)$/, 'word/_rels/$1.rels');
      const file = zip.file(relsName);
      const xml = file === null ? '' : await file.async('string');
      return [partName, xml] as const;
    })
  );
  return Object.fromEntries(entries);
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

  it('is pure: never mutates composition or ctx, and repeat calls render structurally-equivalent headers/footers XML', async () => {
    const composition: HeaderFooterComposition = {
      style: { bold: true },
      header: { center: { content: [{ kind: 'sectionTitle' }] } },
      footer: { right: { content: [{ kind: 'pageNumber' }] } },
      variants: {
        first: { header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } } },
      },
      pageNumbering: { mode: 'restartPerSpec', startAt: 3 },
      raw: { warnings: ['unsupported watermark'] },
    };
    const compositionSnapshot = structuredClone(composition);
    const ctxSnapshot = structuredClone(CTX);

    const first = renderHeaderFooterComposition(composition, CTX);
    const second = renderHeaderFooterComposition(composition, CTX);

    expect(composition).toEqual(compositionSnapshot);
    expect(CTX).toEqual(ctxSnapshot);

    const firstXml = await extractHeaderFooterXml(first.headers, first.footers);
    const secondXml = await extractHeaderFooterXml(second.headers, second.footers);
    expect(secondXml).toEqual(firstXml);
    expect(Object.keys(firstXml)).not.toHaveLength(0);
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

  it('never aliases composition.raw.warnings — returns a defensive copy', () => {
    const warnings = ['unsupported watermark'];
    const composition: HeaderFooterComposition = { raw: { warnings } };
    const result = renderHeaderFooterComposition(composition, CTX);
    expect(result.warnings).toEqual(warnings);
    expect(result.warnings).not.toBe(warnings);
    expect(composition.raw?.warnings).not.toBe(result.warnings);
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
          default: {
            header: { center: { content: [{ kind: 'literal', text: 'DEFAULT' }] } },
            footer: { right: { content: [{ kind: 'pageNumber' }] } },
          },
          first: {
            header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } },
            footer: { right: { content: [{ kind: 'literal', text: 'COVER PAGE' }] } },
          },
          even: {
            header: { center: { content: [{ kind: 'literal', text: 'EVEN' }] } },
            footer: { right: { content: [{ kind: 'pageNumber' }] } },
          },
        },
      },
      CTX
    );
    const parts = await unzipParts(result.headers, result.footers);
    const headerParts = [...parts].filter((name) => /^word\/header\d+\.xml$/.test(name));
    const footerParts = [...parts].filter((name) => /^word\/footer\d+\.xml$/.test(name));
    expect(headerParts).toHaveLength(3);
    expect(footerParts).toHaveLength(3);
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

describe('renderHeaderFooterComposition — image warnings wire into the top-level warnings array (#308)', () => {
  it('is unchanged from the old raw-only pass-through when no image fields are present', () => {
    const warnings = ['unsupported watermark'];
    const composition: HeaderFooterComposition = {
      header: { center: { content: [{ kind: 'sectionTitle' }] } },
      raw: { warnings },
    };
    expect(renderHeaderFooterComposition(composition, CTX).warnings).toEqual(warnings);
  });

  it('appends image warnings after raw.warnings, in header default/first/even then footer default/first/even order', () => {
    const composition: HeaderFooterComposition = {
      header: { left: brokenImageCell() },
      footer: { left: brokenImageCell() },
      variants: {
        first: { header: { left: brokenImageCell() } },
        even: { footer: { left: brokenImageCell() } },
      },
      raw: { warnings: ['unsupported watermark'] },
    };
    const warnings = renderHeaderFooterComposition(composition, CTX).warnings;
    const prefixes = warnings.map((warning) => warning.split(': ')[0]);
    expect(prefixes).toEqual([
      'unsupported watermark',
      'header.left',
      'header.first.left',
      'footer.left',
      'footer.even.left',
    ]);
  });

  it('is [] when no image fields carry warnings, even across default/first/even variants', () => {
    const composition: HeaderFooterComposition = {
      variants: {
        default: { header: { left: imageCell() } },
        first: { header: { left: imageCell() } },
        even: { footer: { left: imageCell() } },
      },
    };
    expect(renderHeaderFooterComposition(composition, CTX).warnings).toEqual([]);
  });
});

describe('renderHeaderFooterComposition — image rendering + multi-variant dedup (#308)', () => {
  it('renders a header image into a real docx round-trip with no warnings', async () => {
    const composition: HeaderFooterComposition = { header: { left: imageCell() } };
    const result = renderHeaderFooterComposition(composition, CTX);
    expect(result.warnings).toEqual([]);

    const doc = new Document({
      sections: [
        { ...(result.headers !== undefined ? { headers: result.headers } : {}), children: [] },
      ],
    });
    const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
    const headerFile = zip.file('word/header1.xml');
    if (!headerFile) throw new Error('word/header1.xml missing');
    const xml = await headerFile.async('string');
    expect(xml).toContain('<w:drawing>');

    const mediaNames = Object.entries(zip.files).filter(
      ([name, entry]) => name.startsWith('word/media/') && !entry.dir
    );
    expect(mediaNames).toHaveLength(1);
  });

  it('dedups one image shared across default/first/even variants into a single media part, collision-free', async () => {
    const composition: HeaderFooterComposition = {
      variants: {
        default: { header: { left: imageCell() } },
        first: { header: { left: imageCell() } },
        even: { header: { left: imageCell() } },
      },
    };
    const result = renderHeaderFooterComposition(composition, CTX);
    expect(result.warnings).toEqual([]);

    const doc = new Document({
      sections: [
        { ...(result.headers !== undefined ? { headers: result.headers } : {}), children: [] },
      ],
    });
    const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
    const headerParts = Object.keys(zip.files).filter((name) =>
      /^word\/header\d+\.xml$/.test(name)
    );
    expect(headerParts).toHaveLength(3);
    for (const name of headerParts) {
      const file = zip.file(name);
      if (!file) throw new Error(`${name} missing`);
      const xml = await file.async('string');
      expect(xml).toContain('<w:drawing>');
    }

    const mediaNames = Object.entries(zip.files).filter(
      ([name, entry]) => name.startsWith('word/media/') && !entry.dir
    );
    // Implementation ASSUMPTION, not the invariant under test: docx's Packer
    // dedups byte-identical image data, so the three identical logos are
    // expected to collapse into a single `word/media` part. That dedup is
    // docx's behavior (not a documented-stable contract SpecR owns) — pinned
    // here only so a future docx change that stops deduping is noticed, never
    // as the property this test exists to guard.
    expect(
      mediaNames,
      'implementation assumption: docx dedups identical image bytes into one media part'
    ).toHaveLength(1);
    const mediaTargets = new Set(
      mediaNames.map(([name]) => `media/${name.replace('word/media/', '')}`)
    );

    // The invariant SpecR OWNS and this test exists to guard ("collision-free"
    // wiring): each header instance's OWN `_rels/headerN.xml.rels` declares
    // exactly one image relationship whose Target resolves to a real media
    // part, and that header's own XML embeds exactly the relationship id its
    // own rels file declares — never a sibling's id (which would render as a
    // broken image in Word even though the media part itself is present). This
    // holds whether or not the media bytes are shared across parts.
    const xmlByPart = await extractHeaderFooterXml(result.headers, result.footers);
    const relsByPart = await extractHeaderFooterRels(result.headers, result.footers);
    expect(Object.keys(relsByPart)).toHaveLength(3);
    for (const [partName, relsXml] of Object.entries(relsByPart)) {
      const relMatches = [...relsXml.matchAll(/<Relationship\b[^>]*\/>/g)];
      expect(relMatches).toHaveLength(1);

      const relId = /<Relationship\b[^>]*\bId="([^"]+)"/.exec(relsXml)?.[1];
      const target = /<Relationship\b[^>]*\bTarget="([^"]+)"/.exec(relsXml)?.[1];
      if (relId === undefined || target === undefined) {
        throw new Error(`${partName} rels: missing relationship Id/Target`);
      }
      expect(mediaTargets.has(target)).toBe(true);
      expect(xmlByPart[partName]).toContain(`r:embed="${relId}"`);
    }
  });
});
