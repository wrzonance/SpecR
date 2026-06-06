import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateDocx } from './index.js';
import type { SpecTree } from '../ast/types.js';

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
