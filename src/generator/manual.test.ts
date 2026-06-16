import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateManual } from './index.js';
import { GeneratorError } from './error.js';
import type { SpecTree } from '../ast/types.js';

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
    const buffer = await generateManual([SECTION_A, SECTION_B]);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('produces a valid DOCX (ZIP) buffer', async () => {
    const buffer = await generateManual([SECTION_A, SECTION_B]);
    await expect(JSZip.loadAsync(buffer)).resolves.toBeDefined();
  });

  it('includes both sections in MasterFormat order', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B]));
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
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B]));
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
    const distinct = new Set(numIds);
    expect(distinct.size).toBe(2);
  });

  it('inserts an OOXML section break between sections', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B]));
    const sectPrCount = [...xml.matchAll(/<w:sectPr/g)].length;
    expect(sectPrCount).toBeGreaterThanOrEqual(2);
  });

  it('wraps every paragraph in its UUID content control anchor', async () => {
    const xml = await getDocXml(await generateManual([SECTION_A, SECTION_B]));
    // Non-vanished nodes: A = a1,a2,a3 (3) + B = b1,b2 (2) = 5. Titles are synthetic.
    const uuidMatches = xml.match(/specr-uuid-/g) ?? [];
    expect(uuidMatches.length).toBe(5);
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-0000000000a1');
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-0000000000b1');
  });

  it('throws GeneratorError when no sections are supplied', async () => {
    await expect(generateManual([])).rejects.toBeInstanceOf(GeneratorError);
  });
});
