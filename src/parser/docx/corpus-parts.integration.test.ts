import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, globSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parse } from '../index.js';
import { HeaderFooterCompositionSchema } from '../../ast/index.js';
import type { SpecNode } from '../../ast/types.js';

// Whole reference corpus is copyrighted and gitignored under
// docs/references/**/*.docx — this end-to-end sweep skips in CI and runs only where
// the files are present locally. It is the standing guard for "every real spec parses
// to the standard 3 parts with sane levels" across every vendor convention we ingest.
const REF = resolve('docs/references');
const CORPUS = existsSync(REF)
  ? globSync(`${REF}/**/*.docx`).sort((a, b) => a.localeCompare(b))
  : [];

// Documented non-3-part inputs (not full specs):
//  • paring-fixes.docx — a 35-paragraph fragment (PART 1 only), a parser test fixture.
//  • 11_53_00nle.docx  — a failed download: 69 bytes of "Error occurred while
//    generating the document." saved with a .docx extension; must be REJECTED, not parsed.
const FRAGMENTS = new Set(['paring-fixes.docx']);
const INVALID = new Set(['11_53_00nle.docx']);

function visibleParts(tree: { parts: readonly SpecNode[] }): SpecNode[] {
  return tree.parts.filter((n) => n.type === 'part' && n.meta.vanish !== true);
}

describe.skipIf(CORPUS.length === 0)('DOCX corpus — every real spec parses to 3 parts', () => {
  for (const file of CORPUS) {
    const name = basename(file);

    if (INVALID.has(name)) {
      it(`${name}: a corrupt/non-docx download is rejected, not parsed`, async () => {
        await expect(parse(readFileSync(file), name)).rejects.toThrow();
      });
      continue;
    }

    it(`${name}: standard 3-part CSI structure (GENERAL/PRODUCTS/EXECUTION)`, async () => {
      const { tree } = await parse(readFileSync(file), name);
      const parts = visibleParts(tree);

      if (FRAGMENTS.has(name)) {
        expect(parts.length).toBeGreaterThanOrEqual(1);
        return;
      }

      expect(parts.length).toBe(3);
      // Canonical names, tolerant of vendor spelling — the typed number prefix
      // ("2.0 PRODUCTS") must already be stripped, so match on the letters only.
      const names = parts.map((p) => p.text.toUpperCase().replace(/[^A-Z]/g, ''));
      expect(names[0]).toContain('GENERAL');
      expect(names[1]).toContain('PRODUCT');
      expect(names[2]).toContain('EXECUTION');
    });
  }
});

// Task 19 (#306): header/footer capture must be a clean no-op across the whole
// corpus — it never throws for document-content reasons, and any composition it
// does produce is a valid HeaderFooterComposition. Unlike the 3-part sweep above,
// there is no fixed expected shape here (most vendor DOCX headers/footers are
// unmodeled-but-preserved, not the small recognized-field subset), so this only
// pins the two things captureHeaderFooter's contract actually promises.
describe.skipIf(CORPUS.length === 0)(
  'DOCX corpus — header/footer capture is a clean, well-typed no-op',
  () => {
    for (const file of CORPUS) {
      const name = basename(file);
      if (INVALID.has(name)) continue;

      it(`${name}: captures a header/footer composition without a capture failure`, async () => {
        const { tree } = await parse(readFileSync(file), name);
        if (tree.headerFooter === undefined) return;
        expect(() => HeaderFooterCompositionSchema.parse(tree.headerFooter)).not.toThrow();
      });
    }
  }
);

// Regression (CPI_DATA_COMMUNICATIONS_WIRELESS_ACCESS_POINTS.docx): an unstyled doc that
// types its whole outline as a decimal ladder. Its PART headings "2.0 PRODUCTS" /
// "3.0 EXECUTION" were read as articles (^\d+\.\d+) and nested under PART 1 GENERAL,
// collapsing all 9,320 paragraphs into one part. Now: 3 parts, and PART 1's manual
// N.N/N.N.N/N.N.N.N outline nests correctly with the typed numbers stripped.
const WIRELESS = resolve(
  'docs/references/MANUFACTURER_CPI/CPI_DATA_COMMUNICATIONS_WIRELESS_ACCESS_POINTS_CSIMFS.docx'
);
describe.skipIf(!existsSync(WIRELESS))('WIRELESS — N.0 parts + manual decimal outline', () => {
  it('splits into 3 parts with the decimal prefix stripped from PRODUCTS/EXECUTION', async () => {
    const { tree } = await parse(readFileSync(WIRELESS), 'wireless.docx');
    expect(visibleParts(tree).map((p) => p.text)).toEqual(['GENERAL', 'PRODUCTS', 'EXECUTION']);
  });

  it('nests PART 1 SUBMITTALS → Product Data → sub-items, numbers stripped from text', async () => {
    const { tree } = await parse(readFileSync(WIRELESS), 'wireless.docx');
    const general = visibleParts(tree).find((p) => p.text === 'GENERAL');
    const submittals = general?.children.find(
      (c) => c.type === 'article' && c.text === 'SUBMITTALS'
    );
    const productData = submittals?.children.find(
      (c) => c.type === 'pr1' && c.text.startsWith('Product Data')
    );
    // "1.4.2.1 Installation Instructions" → pr2 "Installation Instructions"
    const subItems = (productData?.children ?? []).filter((c) => c.type === 'pr2');
    expect(subItems.map((c) => c.text)).toContain('Installation Instructions');
    // no residual leading outline number survived the strip
    expect(subItems.every((c) => !/^\d+\.\d/.test(c.text))).toBe(true);
  });

  // KNOWN AMBIGUITY: WIRELESS PART 2/3 nest imperfectly. The doc is unstyled and uses a
  // ~360-twip indent step, but Signal 5 assumes 576 twips/level, so unnumbered fragments
  // at 360 twips round to the article tier and interleave with the real decimal items.
  // Different vendor docs use different steps (BUSBAR ~720, WIRELESS ~360), so a fixed
  // tolerance cannot fix this without per-document indent-step detection (out of scope).
  // The critical guarantee (exactly 3 parts, content preserved) still holds.
  it('KNOWN AMBIGUITY: still yields exactly 3 parts despite imperfect PART 2/3 nesting', async () => {
    const { tree } = await parse(readFileSync(WIRELESS), 'wireless.docx');
    expect(visibleParts(tree).length).toBe(3);
  });
});

// Regression (reserved-low-level fixtures): the lead-in style PR1lc ("Section
// Includes:") carries no numbering and was dropped to a continuation, orphaning its PR2
// list at the article tier. It now occupies the pr1 tier so the list nests under it.
const CABINETS = resolve(
  'docs/references/MANUFACTURER_CPI/CPI_COMMUNICATIONS_CABINETS_RACKS_FRAMES_ENCLOSURES_CSIMFS.docx'
);
describe.skipIf(!existsSync(CABINETS))('CABINETS fixture — PR1lc lead-in nests its list', () => {
  it('"Section Includes:" is a pr1 with pr2 children (not an orphaning continuation)', async () => {
    const { tree } = await parse(readFileSync(CABINETS), 'cabinets.docx');
    const general = visibleParts(tree).find((p) => p.text === 'GENERAL');
    const summary = general?.children.find((c) => c.type === 'article' && c.text === 'SUMMARY');
    const includes = summary?.children.find(
      (c) => c.type === 'pr1' && c.text.startsWith('Section Includes')
    );
    expect(includes).toBeDefined();
    expect((includes?.children ?? []).filter((c) => c.type === 'pr2').length).toBeGreaterThan(3);
  });
});
