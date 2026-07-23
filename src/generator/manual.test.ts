import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateManual } from './index.js';
import { GeneratorError } from './error.js';
import type { ManualMeta } from './front-matter.js';
import type { SpecTree } from '../ast/types.js';
import type { HeaderFooterComposition } from '../ast/index.js';

const META: ManualMeta = { name: 'Acme Tower', description: 'New HQ tower' };

// Two-section fixture: each section has a single PART → ARTICLE → PR1 chain so
// that, when numbering restarts per section, both PART headings are logically
// "PART 1" within their own section.
const SECTION_A: SpecTree = {
  id: '00000000-0000-0000-0000-0000000000a0',
  section: '03 30 00',
  title: 'Cast-in-Place Concrete',
  parts: [
    {
      id: '00000000-0000-0000-0000-0000000000a1',
      type: 'part',
      text: 'GENERAL',
      meta: {},
      children: [
        {
          id: '00000000-0000-0000-0000-0000000000a2',
          type: 'article',
          text: 'SUMMARY',
          meta: {},
          children: [
            {
              id: '00000000-0000-0000-0000-0000000000a3',
              type: 'pr1',
              text: 'Section includes cast-in-place concrete.',
              meta: {},
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

const SECTION_B: SpecTree = {
  id: '00000000-0000-0000-0000-0000000000b0',
  section: '09 91 00',
  title: 'Painting',
  parts: [
    {
      id: '00000000-0000-0000-0000-0000000000b1',
      type: 'part',
      text: 'GENERAL',
      meta: {},
      children: [
        {
          id: '00000000-0000-0000-0000-0000000000b2',
          type: 'article',
          text: 'REFERENCES',
          meta: {},
          children: [],
        },
      ],
    },
  ],
};

async function getDocXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml not found in generated DOCX');
  return file.async('string');
}

describe('generateManual', () => {
  it('returns a single non-empty Buffer (one DOCX stream)', async () => {
    const buffer = await generateManual([SECTION_A, SECTION_B], META);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('produces a valid DOCX (ZIP) buffer', async () => {
    const buffer = await generateManual([SECTION_A, SECTION_B], META);
    await expect(JSZip.loadAsync(buffer)).resolves.toBeDefined();
  });

  it('includes both sections in MasterFormat order', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
    expect(xml).toContain('SECTION 03 30 00');
    expect(xml).toContain('Cast-in-Place Concrete');
    expect(xml).toContain('SUMMARY');
    expect(xml).toContain('SECTION 09 91 00');
    expect(xml).toContain('Painting');
    expect(xml).toContain('REFERENCES');
    // Order: section A's title precedes section B's title.
    expect(xml.indexOf('Cast-in-Place Concrete')).toBeLessThan(xml.indexOf('Painting'));
  });

  it('numbering restarts per section: each section uses a distinct numbering instance', async () => {
    // KNOWN AMBIGUITY: Word computes the displayed "PART 1" at open time; this
    // test asserts the distinct numId/abstractNum structure that guarantees restart.
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
    const distinct = new Set(numIds);
    expect(distinct.size).toBe(2);
  });

  it('inserts an OOXML section break between sections', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
    const sectPrCount = [...xml.matchAll(/<w:sectPr/g)].length;
    expect(sectPrCount).toBeGreaterThanOrEqual(2);
  });

  it('wraps every paragraph in its UUID content control anchor', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
    // Non-vanished nodes: A = a1,a2,a3 (3) + B = b1,b2 (2) = 5. Titles are synthetic.
    const uuidMatches = xml.match(/specr-uuid-/g) ?? [];
    expect(uuidMatches.length).toBe(5);
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-0000000000a1');
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-0000000000b1');
  });

  it('opens with a cover carrying the project name and description', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
    expect(xml).toContain('Acme Tower');
    expect(xml).toContain('New HQ tower');
    // Cover precedes the first section title.
    expect(xml.indexOf('Acme Tower')).toBeLessThan(xml.indexOf('SECTION 03 30 00'));
  });

  it('emits a TOC field code before the first section', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
    const tocMatch = /instrText[^>]*>TOC .*\\o &quot;1-1&quot;/.exec(xml);
    expect(tocMatch).not.toBeNull();
    expect(xml.search(/instrText[^>]*>TOC/)).toBeLessThan(xml.indexOf('SECTION 03 30 00'));
  });

  it('styles each section title Heading1 — one TOC entry per section, in TOC order', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
    // Section titles carry "SECTION <number>"; assert they appear in TOC order.
    const titles = [...xml.matchAll(/SECTION (\d\d \d\d \d\d)/g)].map((m) => m[1]);
    expect(titles).toEqual(['03 30 00', '09 91 00']);
    // Heading1 paragraphs = the two section titles only. The "Table of Contents"
    // label is intentionally NOT Heading1, so the TOC field (\o "1-1") yields one
    // entry per section and never lists its own title.
    const h1 = [...xml.matchAll(/<w:pStyle w:val="Heading1"\/>/g)].length;
    expect(h1).toBe(2);
  });

  it('throws GeneratorError when no sections are supplied', async () => {
    await expect(generateManual([], META)).rejects.toBeInstanceOf(GeneratorError);
  });
});

const HEADER_FOOTER_COMPOSITION: HeaderFooterComposition = {
  header: {
    center: {
      content: [
        { kind: 'sectionNumber' },
        { kind: 'literal', text: ' — ' },
        { kind: 'sectionTitle' },
      ],
    },
  },
  footer: {
    right: { content: [{ kind: 'pageNumber' }] },
  },
};

const EVEN_COMPOSITION: HeaderFooterComposition = {
  ...HEADER_FOOTER_COMPOSITION,
  variants: {
    even: { header: { center: { content: [{ kind: 'literal', text: 'EVEN PAGE HEADER' }] } } },
  },
};

const FIRST_PAGE_COMPOSITION: HeaderFooterComposition = {
  ...HEADER_FOOTER_COMPOSITION,
  variants: {
    first: { header: { center: { content: [{ kind: 'literal', text: 'FIRST PAGE HEADER' }] } } },
  },
};

async function headerFooterPartNames(buffer: Buffer): Promise<{
  headers: readonly string[];
  footers: readonly string[];
}> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  return {
    headers: names
      .filter((name) => /^word\/header\d+\.xml$/.test(name))
      .sort((a, b) => a.localeCompare(b)),
    footers: names
      .filter((name) => /^word\/footer\d+\.xml$/.test(name))
      .sort((a, b) => a.localeCompare(b)),
  };
}

async function readZipPart(buffer: Buffer, partName: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(partName);
  if (!file) throw new Error(`${partName} missing from generated DOCX`);
  return file.async('string');
}

// `docProps/core.xml` carries a wall-clock `dcterms:created`/`dcterms:modified`
// timestamp docx stamps on every `Packer.toBuffer` call — pre-existing,
// unrelated to #481, and the one part that legitimately differs between two
// otherwise-identical generations. Excluding it turns "byte-identical output"
// into a check of actual document content rather than wall-clock noise.
async function contentPartsExcludingTimestamp(buffer: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => name !== 'docProps/core.xml' && !zip.files[name]?.dir)
      .sort((a, b) => a.localeCompare(b))
      .map(async (name) => {
        const file = zip.file(name);
        if (!file) throw new Error(`${name} missing from generated DOCX`);
        return [name, await file.async('string')] as const;
      })
  );
  return Object.fromEntries(entries);
}

// #481: generateManual previously discarded options.headerFooter entirely
// (ADR-017/303 scoped header/footer rendering to standalone generateDocx
// only). These tests pin the manual-scoped wiring's invariants at the
// boundary — never the per-section OOXML internals.
describe('generateManual — #481 header/footer wiring', () => {
  it('omitting options.headerFooter reproduces byte-identical output to calling without options at all (pre-#481 baseline)', async () => {
    const withoutOptions = await generateManual([SECTION_A, SECTION_B], META);
    // A defined `options` object that still omits `headerFooter` must take the
    // exact same code path as `options` being absent entirely — proves the
    // gate is on `headerFooter`, not on `options` itself.
    const withOptionsMinusHeaderFooter = await generateManual(
      [SECTION_A, SECTION_B],
      META,
      undefined,
      { sectionNumberFormat: 'canonical' }
    );
    expect(await contentPartsExcludingTimestamp(withOptionsMinusHeaderFooter)).toEqual(
      await contentPartsExcludingTimestamp(withoutOptions)
    );
  });

  it('front-matter section never carries a header/footer reference, regardless of options.headerFooter', async () => {
    const xml = await getDocXml(
      await generateManual([SECTION_A, SECTION_B], META, undefined, {
        headerFooter: { composition: HEADER_FOOTER_COMPOSITION, current: {} },
      })
    );
    const firstSectionTitleIndex = xml.indexOf('SECTION 03 30 00');
    expect(firstSectionTitleIndex).toBeGreaterThan(-1);
    const frontMatterXml = xml.slice(0, firstSectionTitleIndex);
    expect(frontMatterXml).not.toContain('w:headerReference');
    expect(frontMatterXml).not.toContain('w:footerReference');
  });

  it('each spec section renders its own header/footer parts sourced from its own SpecTree (zero collisions)', async () => {
    const buffer = await generateManual([SECTION_A, SECTION_B], META, undefined, {
      headerFooter: { composition: HEADER_FOOTER_COMPOSITION, current: {} },
    });
    const { headers, footers } = await headerFooterPartNames(buffer);
    expect(headers.length).toBe(2);
    expect(footers.length).toBe(2);

    const headerContents = await Promise.all(headers.map((name) => readZipPart(buffer, name)));
    const carriesA = headerContents.filter(
      (xml) => xml.includes('03 30 00') && xml.includes('Cast-in-Place Concrete')
    );
    const carriesB = headerContents.filter(
      (xml) => xml.includes('09 91 00') && xml.includes('Painting')
    );
    // Exactly one header carries each section's own sectionNumber/title —
    // never both in one file, never swapped between sections.
    expect(carriesA.length).toBe(1);
    expect(carriesB.length).toBe(1);
    expect(carriesA[0]).not.toContain('Painting');
    expect(carriesB[0]).not.toContain('Cast-in-Place Concrete');
  });

  it('header/footer relationship IDs are unique across sections (no collisions)', async () => {
    const buffer = await generateManual([SECTION_A, SECTION_B], META, undefined, {
      headerFooter: { composition: HEADER_FOOTER_COMPOSITION, current: {} },
    });
    const relsXml = await readZipPart(buffer, 'word/_rels/document.xml.rels');
    const relIds = [
      ...relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="(?:header|footer)\d+\.xml"/g),
    ].map((m) => m[1]);
    // 2 sections × (1 header + 1 footer) = 4 distinct relationship IDs.
    expect(relIds.length).toBe(4);
    expect(new Set(relIds).size).toBe(relIds.length);
  });

  it('single-tree manual (N=1) still renders its own section header/footer', async () => {
    const buffer = await generateManual([SECTION_A], META, undefined, {
      headerFooter: { composition: HEADER_FOOTER_COMPOSITION, current: {} },
    });
    const { headers, footers } = await headerFooterPartNames(buffer);
    expect(headers.length).toBe(1);
    expect(footers.length).toBe(1);
    const headerXml = await readZipPart(buffer, headers[0] as string);
    expect(headerXml).toContain('03 30 00');
    expect(headerXml).toContain('Cast-in-Place Concrete');
  });

  it('document-level evenAndOddHeaders reflects the shared composition (proof: composition is the same object reference for every section, so first-section computation is always correct)', async () => {
    const withEven = await generateManual([SECTION_A, SECTION_B], META, undefined, {
      headerFooter: { composition: EVEN_COMPOSITION, current: {} },
    });
    const settingsWithEven = await readZipPart(withEven, 'word/settings.xml');
    expect(settingsWithEven).toMatch(/<w:evenAndOddHeaders\/>/);

    const withoutEven = await generateManual([SECTION_A, SECTION_B], META, undefined, {
      headerFooter: { composition: HEADER_FOOTER_COMPOSITION, current: {} },
    });
    const settingsWithoutEven = await readZipPart(withoutEven, 'word/settings.xml');
    expect(settingsWithoutEven).not.toMatch(/<w:evenAndOddHeaders\/>/);
  });

  it("variants.first (titlePage) applies per-OOXML-section — every section opening page gets first-page treatment, not just the manual's first page", async () => {
    const xml = await getDocXml(
      await generateManual([SECTION_A, SECTION_B], META, undefined, {
        headerFooter: { composition: FIRST_PAGE_COMPOSITION, current: {} },
      })
    );
    const titlePgCount = [...xml.matchAll(/<w:titlePg/g)].length;
    // Both section A's and section B's own sectPr set titlePage — the manual
    // is not treated as one continuous flow with a single first page.
    expect(titlePgCount).toBe(2);
  });

  it('front matter never gets titlePage treatment, even when options.headerFooter sets variants.first', async () => {
    const xml = await getDocXml(
      await generateManual([SECTION_A, SECTION_B], META, undefined, {
        headerFooter: { composition: FIRST_PAGE_COMPOSITION, current: {} },
      })
    );
    const firstSectionTitleIndex = xml.indexOf('SECTION 03 30 00');
    const frontMatterXml = xml.slice(0, firstSectionTitleIndex);
    expect(frontMatterXml).not.toContain('<w:titlePg');
  });
});

// #509: each spec section's own `w:pgSz` must reflect that tree's own
// captured pageSize (never a sibling's, never the manual-wide first
// section's), and the front-matter section — which has no source SpecTree
// of its own — resolves from `trees[0]?.pageSize`, not from any header/footer
// render. `w:pgSz` blocks appear in document order: front matter, then one
// per spec section (confirmed via a real generated document).
describe('generateManual — #509 page size', () => {
  function pgSzBlocks(xml: string): readonly string[] {
    return [...xml.matchAll(/<w:pgSz\b[^/]*\/>/g)].map((m) => m[0]);
  }

  it('front matter takes its page size from trees[0], and each section keeps its own — never a sibling’s', async () => {
    const sectionA: SpecTree = {
      ...SECTION_A,
      pageSize: { width: 12240, height: 15840, orientation: 'portrait' },
    };
    const sectionB: SpecTree = {
      ...SECTION_B,
      pageSize: { width: 15840, height: 12240, orientation: 'landscape' },
    };
    const xml = await getDocXml(await generateManual([sectionA, sectionB], META));
    const blocks = pgSzBlocks(xml);
    expect(blocks).toHaveLength(3);
    // Front matter (no SpecTree of its own) resolves from trees[0] — section A.
    expect(blocks[0]).toBe('<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>');
    expect(blocks[1]).toBe('<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>');
    expect(blocks[2]).toBe('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>');
  });

  it('defaults every section (front matter included) to Letter when no tree carries a pageSize', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B], META));
    const blocks = pgSzBlocks(xml);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block).toBe('<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>');
    }
  });

  it('front matter resolves from trees[0].pageSize, not from any header/footer render (#303 render is unrelated to page size)', async () => {
    const sectionA: SpecTree = {
      ...SECTION_A,
      pageSize: { width: 15840, height: 12240, orientation: 'landscape' },
    };
    const xml = await getDocXml(
      await generateManual([sectionA, SECTION_B], META, undefined, {
        headerFooter: { composition: HEADER_FOOTER_COMPOSITION, current: {} },
      })
    );
    const blocks = pgSzBlocks(xml);
    expect(blocks[0]).toBe('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>');
  });
});
