import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateDocx } from './index.js';
import type { SpecTree } from '../ast/types.js';
import type { StyleRule } from '../ast/index.js';

// Covers: part, article, pr1, pr2, note, continuation, vanish
const SYNTHETIC_TREE: SpecTree = {
  id: '00000000-0000-0000-0000-000000000001',
  section: '27 21 00',
  title: 'Structured Cabling',
  parts: [
    {
      id: '00000000-0000-0000-0000-000000000002',
      type: 'part',
      text: 'GENERAL',
      meta: {},
      children: [
        {
          id: '00000000-0000-0000-0000-000000000003',
          type: 'article',
          text: 'REFERENCES',
          meta: {},
          children: [
            {
              id: '00000000-0000-0000-0000-000000000004',
              type: 'pr1',
              text: 'Referenced Documents',
              meta: {},
              children: [
                {
                  id: '00000000-0000-0000-0000-000000000005',
                  type: 'pr2',
                  text: 'ASTM C150',
                  meta: {},
                  children: [],
                },
              ],
            },
            {
              id: '00000000-0000-0000-0000-000000000006',
              type: 'note',
              text: 'Verify local conditions.',
              meta: {},
              children: [],
            },
            {
              id: '00000000-0000-0000-0000-000000000007',
              type: 'continuation',
              text: 'Continued text here.',
              meta: {},
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: '00000000-0000-0000-0000-000000000010',
      type: 'part',
      text: 'PRODUCTS',
      meta: {},
      children: [
        {
          id: '00000000-0000-0000-0000-000000000011',
          type: 'article',
          text: 'MATERIALS',
          meta: {},
          children: [
            {
              id: '00000000-0000-0000-0000-000000000012',
              type: 'pr1',
              text: 'Hidden requirement',
              meta: { vanish: true },
              children: [
                {
                  id: '00000000-0000-0000-0000-000000000013',
                  type: 'pr2',
                  text: 'Child of hidden — also excluded',
                  meta: {},
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const REF_TREE: SpecTree = {
  id: '00000000-0000-0000-0000-000000000100',
  section: '09 91 00',
  title: 'Painting',
  parts: [
    {
      id: '00000000-0000-0000-0000-000000000101',
      type: 'part',
      text: 'GENERAL',
      meta: {},
      children: [
        {
          id: '00000000-0000-0000-0000-000000000102',
          type: 'article',
          text: 'RELATED REQUIREMENTS',
          meta: {},
          children: [
            {
              id: '00000000-0000-0000-0000-000000000103',
              type: 'pr1',
              text: 'See Section 26 00 13.10 and Section 099100.',
              meta: {},
              children: [],
            },
            {
              id: '00000000-0000-0000-0000-000000000104',
              type: 'pr1',
              text: 'Manufacturer Part No. 099100; ASME 123456.',
              meta: {},
              children: [],
            },
          ],
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

describe('generateDocx', () => {
  it('returns a non-empty Buffer', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('generates a valid ZIP (DOCX is a ZIP)', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    await expect(JSZip.loadAsync(buffer)).resolves.toBeDefined();
  });

  it('document.xml contains numbered node text', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('GENERAL');
    expect(xml).toContain('REFERENCES');
    expect(xml).toContain('Referenced Documents');
    expect(xml).toContain('ASTM C150');
    expect(xml).toContain('PRODUCTS');
    expect(xml).toContain('MATERIALS');
  });

  it('document.xml contains title paragraph', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('SECTION 27 21 00');
    expect(xml).toContain('27 21 00');
    expect(xml).toContain('Structured Cabling');
  });

  it('document.xml contains note with [NOTE] prefix', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('[NOTE]');
    expect(xml).toContain('Verify local conditions.');
  });

  it('document.xml contains continuation text', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('Continued text here.');
  });

  it('document.xml excludes vanished node and its children', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    expect(xml).not.toContain('Hidden requirement');
    expect(xml).not.toContain('Child of hidden');
  });

  it('handles empty tree without error', async () => {
    const empty: SpecTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '00 00 00',
      title: 'Empty Spec',
      parts: [],
    };
    const buffer = await generateDocx(empty);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('generateDocx: agency-suffixed section survives into document.xml', async () => {
    const suffixedTree: SpecTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '01 32 01.00 10',
      title: 'Project Schedule',
      parts: [],
    };
    const buffer = await generateDocx(suffixedTree);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('01 32 01.00 10');
  });

  it('generateDocx: dotted sectionNumberFormat applies to title and confident refs', async () => {
    const buffer = await generateDocx(REF_TREE, undefined, { sectionNumberFormat: 'dots' });
    const xml = await getDocXml(buffer);
    expect(xml).toContain('SECTION 09.91.00');
    expect(xml).toContain('See Section 26.00.13.10 and Section 09.91.00.');
  });

  it('generateDocx: compact sectionNumberFormat applies to title and confident refs', async () => {
    const buffer = await generateDocx(REF_TREE, undefined, { sectionNumberFormat: 'compact' });
    const xml = await getDocXml(buffer);
    expect(xml).toContain('SECTION 099100');
    expect(xml).toContain('See Section 260013.10 and Section 099100.');
  });

  it('generateDocx: output policy does not rewrite product or standards contexts', async () => {
    const buffer = await generateDocx(REF_TREE, undefined, { sectionNumberFormat: 'dots' });
    const xml = await getDocXml(buffer);
    expect(xml).toContain('Manufacturer Part No. 099100; ASME 123456.');
  });
});

describe('generateDocx — content controls', () => {
  it('document.xml contains w:sdt elements', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('w:sdt');
  });

  it('wraps part node in specr-uuid content control', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    // part node id: 00000000-0000-0000-0000-000000000002
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-000000000002');
  });

  it('wraps note node in specr-uuid content control', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    // note node id: 00000000-0000-0000-0000-000000000006
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-000000000006');
  });

  it('wraps continuation node in specr-uuid content control', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    // continuation node id: 00000000-0000-0000-0000-000000000007
    expect(xml).toContain('specr-uuid-00000000-0000-0000-0000-000000000007');
  });

  it('does not wrap vanished node', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    // vanished node id: 00000000-0000-0000-0000-000000000012
    expect(xml).not.toContain('specr-uuid-00000000-0000-0000-0000-000000000012');
  });

  it('title paragraph is not wrapped (no SpecNode.id)', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('27 21 00');
    expect(xml).toContain('Structured Cabling');
    // Non-vanished nodes: 002,003,004,005,006,007 (part1 subtree) + 010,011 (part2 subtree) = 8
    // Title paragraph is synthetic — no UUID tag
    const uuidMatches = xml.match(/specr-uuid-/g) ?? [];
    expect(uuidMatches.length).toBe(8);
  });
});

const ARIAL_RULES: readonly StyleRule[] = [
  {
    nodeType: 'part',
    properties: {
      rPr: { rFonts: { ascii: 'Arial' }, sz: 24, b: true, caps: true },
      pPr: { spacing: { before: 240, after: 240 }, ind: { left: 360 } },
      numbering: { lvlText: 'SECTION %1 -' },
    },
  },
];

describe('generateDocx — style rules', () => {
  it('applies font family and size to styled node runs', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE, ARIAL_RULES);
    const xml = await getDocXml(buffer);
    expect(xml).toContain('Arial');
    expect(xml).toMatch(/w:sz[^/>]*w:val="24"/);
  });

  it('non-ascii rFonts slots (hAnsi/cs/eastAsia) survive into w:rFonts (regression: only ascii was forwarded)', async () => {
    const rules: readonly StyleRule[] = [
      {
        nodeType: 'part',
        properties: {
          rPr: { rFonts: { hAnsi: 'Arial', cs: 'Courier New', eastAsia: 'MS Mincho' } },
        },
      },
    ];
    const xml = await getDocXml(await generateDocx(SYNTHETIC_TREE, rules));
    expect(xml).toMatch(/w:rFonts[^/>]*w:hAnsi="Arial"/);
    expect(xml).toMatch(/w:rFonts[^/>]*w:cs="Courier New"/);
    expect(xml).toMatch(/w:rFonts[^/>]*w:eastAsia="MS Mincho"/);
  });

  it('applies paragraph spacing and indent', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE, ARIAL_RULES);
    const xml = await getDocXml(buffer);
    expect(xml).toMatch(/w:spacing[^/>]*w:before="240"/);
    expect(xml).toMatch(/w:ind[^/>]*"360"/);
  });

  it('applies numbering lvlText override to numbering.xml', async () => {
    const buffer = await generateDocx(SYNTHETIC_TREE, ARIAL_RULES);
    const zip = await JSZip.loadAsync(buffer);
    const numbering = await zip.file('word/numbering.xml')?.async('string');
    expect(numbering).toContain('SECTION %1 -');
  });

  it('no rules → no Arial anywhere (output unchanged)', async () => {
    const plain = await getDocXml(await generateDocx(SYNTHETIC_TREE));
    expect(plain).not.toContain('Arial');
  });

  it('note and continuation runs carry no run-style properties under template rules', async () => {
    const xml = await getDocXml(await generateDocx(SYNTHETIC_TREE, ARIAL_RULES));

    // Part run must carry Arial (confirms rules are applied for styled nodes)
    expect(xml).toMatch(
      /<w:r><w:rPr>.*?w:ascii="Arial".*?<\/w:rPr><w:t[^>]*>GENERAL<\/w:t><\/w:r>/s
    );

    // Note run: <w:r> followed directly by <w:t> — no <w:rPr> block before <w:t>
    // The full run containing [NOTE] must be <w:r><w:t ...>[NOTE]...</w:t></w:r>
    expect(xml).toMatch(/<w:r><w:t[^>]*>\[NOTE\] Verify local conditions\.<\/w:t><\/w:r>/);

    // Continuation run: same — <w:r><w:t> with no intervening <w:rPr>
    expect(xml).toMatch(/<w:r><w:t[^>]*>Continued text here\.<\/w:t><\/w:r>/);

    // Belt-and-suspenders: Arial must not appear in either run's neighbourhood.
    // Extract the raw run for [NOTE] and assert it lacks Arial.
    const noteRunMatch = /<w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>\[NOTE\][^<]*<\/w:t><\/w:r>/s.exec(
      xml
    );
    expect(noteRunMatch).not.toBeNull();
    expect(noteRunMatch?.[1]).toBeUndefined(); // no <w:rPr> captured

    const contRunMatch =
      /<w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>Continued text here\.<\/w:t><\/w:r>/s.exec(xml);
    expect(contRunMatch).not.toBeNull();
    expect(contRunMatch?.[1]).toBeUndefined(); // no <w:rPr> captured
  });
});
