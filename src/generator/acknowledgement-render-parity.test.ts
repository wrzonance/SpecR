import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateDocx, generateSec, renderMarkdown } from './index.js';
import type { SpecNode, SpecTree } from '../ast/types.js';

// #545, ADR-079 follow-on — the invariant this path most risks (VERIFICATION
// BAR): acknowledgement MUST NOT change rendering in any renderer. This is
// the strongest form of that assertion — the SAME tree, differing only in
// `meta.acknowledged` on its note/textBox nodes, must produce byte-identical
// output across markdown, `.SEC`, and DOCX.
//
// DOCX cannot use a whole-Buffer equality check: generating the identical
// tree twice already yields two different Buffers (dolanmiu/docx embeds a
// fresh zip/docProps timestamp on every Packer.toBuffer() call, confirmed
// experimentally during this issue's design spike). The correct comparison
// unzips both buffers and compares the `word/document.xml` part as a string.

function buildTree(acknowledged: boolean): SpecTree {
  const note: SpecNode = {
    id: '00000000-0000-0000-0000-0000000000n1',
    type: 'note',
    text: 'Coordinate finish selection with owner before submittal.',
    children: [],
    meta: acknowledged ? { acknowledged: true } : {},
  };
  const textBox: SpecNode = {
    id: '00000000-0000-0000-0000-0000000000o1',
    type: 'object',
    text: '',
    children: [],
    meta: {
      ...(acknowledged ? { acknowledged: true } : {}),
      object: {
        kind: 'textBox',
        floating: false,
        generation: 'drawingml',
        blob: [
          { 'w:txbxContent': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': 'Callout' }] }] }] }] },
        ],
      },
    },
  };
  const article: SpecNode = {
    id: '00000000-0000-0000-0000-0000000000a1',
    type: 'article',
    text: 'SUMMARY',
    children: [note],
    meta: {},
  };
  const part: SpecNode = {
    id: '00000000-0000-0000-0000-0000000000p1',
    type: 'part',
    text: 'GENERAL',
    children: [article, textBox],
    meta: {},
  };
  return {
    id: '00000000-0000-0000-0000-000000000001',
    section: '09 91 26',
    title: 'Exterior Painting',
    parts: [part],
  };
}

async function docXml(tree: SpecTree): Promise<string> {
  const buffer = await generateDocx(tree);
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

describe('acknowledgement never changes rendering (#545)', () => {
  it('markdown output is byte-identical acknowledged vs unacknowledged', () => {
    const unacknowledged = renderMarkdown(buildTree(false));
    const acknowledged = renderMarkdown(buildTree(true));
    expect(acknowledged).toBe(unacknowledged);
    // Non-vacuous: the note/object content actually appears in both outputs.
    expect(unacknowledged).toContain('Coordinate finish selection with owner before submittal.');
  });

  it('.SEC output is byte-identical acknowledged vs unacknowledged', () => {
    const unacknowledged = generateSec(buildTree(false));
    const acknowledged = generateSec(buildTree(true));
    expect(acknowledged).toBe(unacknowledged);
    expect(unacknowledged).toContain('Coordinate finish selection with owner before submittal.');
  });

  it('DOCX word/document.xml is byte-identical acknowledged vs unacknowledged', async () => {
    const unacknowledged = await docXml(buildTree(false));
    const acknowledged = await docXml(buildTree(true));
    expect(acknowledged).toBe(unacknowledged);
    expect(unacknowledged).toContain('Coordinate finish selection with owner before submittal.');
  });
});
