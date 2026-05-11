import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { assertDocxSafe } from './safety.js';

async function makeZip(
  extras: Record<string, string | Buffer> = {},
  includeRequired = true
): Promise<Buffer> {
  const zip = new JSZip();
  if (includeRequired) {
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
  }
  for (const [name, content] of Object.entries(extras)) {
    if (typeof content === 'string') zip.file(name, content);
    else zip.file(name, content, { compression: 'DEFLATE' });
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const EXTERNAL_RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '  <Relationship Id="rId1"',
  '    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"',
  '    Target="http://evil.example.com/payload"',
  '    TargetMode="External"/>',
  '</Relationships>',
].join('\n');

describe('assertDocxSafe — valid input', () => {
  it('accepts a valid minimal docx', async () => {
    const buf = await makeZip();
    await expect(assertDocxSafe(buf)).resolves.toBeUndefined();
  });
});

describe('assertDocxSafe — non-zip rejection', () => {
  it('rejects a non-zip buffer (bad magic bytes)', async () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    await expect(assertDocxSafe(buf)).rejects.toThrow('not a zip');
  });

  it('rejects an empty buffer', async () => {
    await expect(assertDocxSafe(Buffer.alloc(0))).rejects.toThrow('not a zip');
  });
});

describe('assertDocxSafe — structural rejection', () => {
  it('rejects path traversal in zip entry name', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
    zip.file('word/../../../evil.xml', 'evil');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('path traversal');
  });

  it('rejects zip containing vbaProject.bin (macros)', async () => {
    const buf = await makeZip({ 'word/vbaProject.bin': 'macro content' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('macros not allowed');
  });

  it('rejects zip with unexpected top-level directory', async () => {
    const buf = await makeZip({ 'evil/payload.xml': '<evil/>' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('unexpected zip entry');
  });

  it('rejects zip missing [Content_Types].xml', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('missing [Content_Types].xml');
  });

  it('rejects zip missing word/document.xml', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('missing word/document.xml');
  });
});

describe('assertDocxSafe — bomb and relationship rejection', () => {
  it('rejects zip with suspicious compression ratio (zipbomb indicator)', async () => {
    // 5 MB of repeated 0x41 bytes — compresses to ~5 KB; ratio ~1000x exceeds MAX_RATIO=100
    const bigContent = Buffer.alloc(5 * 1024 * 1024).fill(0x41);
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', bigContent, { compression: 'DEFLATE' });
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('compression ratio');
  });

  it('rejects zip with external relationship (TargetMode="External")', async () => {
    const buf = await makeZip({ 'word/_rels/document.xml.rels': EXTERNAL_RELS_XML });
    await expect(assertDocxSafe(buf)).rejects.toThrow('external relationship');
  });

  it('rejects zip with more than 200 entries', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
    for (let i = 0; i < 200; i++) zip.file(`word/chunk${i}.xml`, '<x/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertDocxSafe(buf)).rejects.toThrow('too many zip entries');
  });
});
