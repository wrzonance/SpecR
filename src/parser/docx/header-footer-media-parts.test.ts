import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { readHeaderFooterMedia } from './header-footer-media-parts.js';
import type { HeaderFooterMediaByPart } from './header-footer-media-parts.js';

const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const HYPERLINK_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

function relsXml(relationships: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function imageRel(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="${IMAGE_REL_TYPE}" Target="${target}"/>`;
}

function hyperlinkRel(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="${HYPERLINK_REL_TYPE}" Target="${target}" TargetMode="External"/>`;
}

function makeZip(files: Record<string, string | Uint8Array>): JSZip {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip;
}

// Simulates a byte fetch that fails during decompression/read (e.g. a
// corrupt media entry), independent of JSZip's own decompression pipeline —
// this pins the ORCHESTRATION invariant (per-entry Promise.allSettled fault
// isolation), not JSZip's internals.
function breakFetch(zip: JSZip, path: string): void {
  const file = zip.file(path);
  if (!file) throw new Error(`test setup: fixture is missing "${path}"`);
  vi.spyOn(file, 'async').mockRejectedValue(new Error('simulated decompression failure'));
}

// Unwraps a 'resolved' part's inner media map, or undefined for any other
// outcome (absent part, or a 'relsUnreadable' part) -- keeps the assertions
// below reading like the pre-#502 flat-map shape while still exercising the
// real tagged-union return type.
function resolvedMedia(
  mediaByPart: HeaderFooterMediaByPart,
  partPath: string
): ReadonlyMap<string, Uint8Array> | undefined {
  const partMedia = mediaByPart.get(partPath);
  if (partMedia === undefined || partMedia.status !== 'resolved') return undefined;
  return partMedia.media;
}

describe('readHeaderFooterMedia', () => {
  it('resolves media bytes for a header part, keyed by owning part path then rId', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>',
      'word/_rels/header1.xml.rels': relsXml(imageRel('rId1', 'media/image1.png')),
      'word/media/image1.png': new Uint8Array([1, 2, 3]),
    });
    const mediaByPart = await readHeaderFooterMedia(zip);
    expect(resolvedMedia(mediaByPart, 'word/header1.xml')?.get('rId1')).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it('resolves media bytes for a footer part the same way', async () => {
    const zip = makeZip({
      'word/footer1.xml': '<w:ftr/>',
      'word/_rels/footer1.xml.rels': relsXml(imageRel('rId1', 'media/image2.png')),
      'word/media/image2.png': new Uint8Array([9, 8, 7]),
    });
    const mediaByPart = await readHeaderFooterMedia(zip);
    expect(resolvedMedia(mediaByPart, 'word/footer1.xml')?.get('rId1')).toEqual(
      new Uint8Array([9, 8, 7])
    );
  });

  it('yields an empty map, not a throw, for a document with no header/footer .rels files', async () => {
    const zip = makeZip({ 'word/document.xml': '<w:document/>' });
    const mediaByPart = await readHeaderFooterMedia(zip);
    expect(mediaByPart.size).toBe(0);
  });

  it('treats a header/footer part with no .rels file as "no media", never an error', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>', // no word/_rels/header1.xml.rels sidecar at all
    });
    const mediaByPart = await readHeaderFooterMedia(zip);
    expect(mediaByPart.get('word/header1.xml')).toBeUndefined();
  });

  it('omits an rId whose relationship target is missing from the archive, without throwing', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>',
      'word/_rels/header1.xml.rels': relsXml(
        imageRel('rId1', 'media/missing.png') + imageRel('rId2', 'media/present.png')
      ),
      'word/media/present.png': new Uint8Array([5]),
    });
    const mediaByPart = await readHeaderFooterMedia(zip);
    const headerMedia = resolvedMedia(mediaByPart, 'word/header1.xml');
    expect(headerMedia?.get('rId1')).toBeUndefined();
    expect(headerMedia?.get('rId2')).toEqual(new Uint8Array([5]));
  });

  it('isolates one rejected media fetch to its own rId -- a sibling rId in the same part is still captured (never a bare Promise.all)', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>',
      'word/_rels/header1.xml.rels': relsXml(
        imageRel('rId1', 'media/corrupt.png') + imageRel('rId2', 'media/good.png')
      ),
      'word/media/corrupt.png': new Uint8Array([0]),
      'word/media/good.png': new Uint8Array([42]),
    });
    breakFetch(zip, 'word/media/corrupt.png');

    const mediaByPart = await readHeaderFooterMedia(zip);
    const headerMedia = resolvedMedia(mediaByPart, 'word/header1.xml');
    expect(headerMedia?.get('rId1')).toBeUndefined();
    expect(headerMedia?.get('rId2')).toEqual(new Uint8Array([42]));
  });

  it('isolates one rejected media fetch to its own part -- a sibling header/footer region is still captured', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>',
      'word/_rels/header1.xml.rels': relsXml(imageRel('rId1', 'media/corrupt.png')),
      'word/media/corrupt.png': new Uint8Array([0]),
      'word/header2.xml': '<w:hdr/>',
      'word/_rels/header2.xml.rels': relsXml(imageRel('rId1', 'media/good.png')),
      'word/media/good.png': new Uint8Array([42]),
    });
    breakFetch(zip, 'word/media/corrupt.png');

    const mediaByPart = await readHeaderFooterMedia(zip);
    expect(resolvedMedia(mediaByPart, 'word/header1.xml')?.get('rId1')).toBeUndefined();
    expect(resolvedMedia(mediaByPart, 'word/header2.xml')?.get('rId1')).toEqual(
      new Uint8Array([42])
    );
  });

  it('filters out non-image relationships, matching parseImageRelationships', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>',
      'word/_rels/header1.xml.rels': relsXml(
        hyperlinkRel('rId1', 'https://example.com/') + imageRel('rId2', 'media/image1.png')
      ),
      'word/media/image1.png': new Uint8Array([1]),
    });
    const mediaByPart = await readHeaderFooterMedia(zip);
    const headerMedia = resolvedMedia(mediaByPart, 'word/header1.xml');
    expect(headerMedia?.size).toBe(1);
    expect(headerMedia?.get('rId2')).toEqual(new Uint8Array([1]));
  });

  // INV-1 (#502): a header/footer part whose .rels XML is malformed degrades
  // that PART to `relsUnreadable` instead of failing the whole DOCX parse.
  it('degrades to relsUnreadable for a header/footer part whose .rels XML is malformed, never throwing', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>',
      'word/_rels/header1.xml.rels': '<not valid xml',
    });
    const mediaByPart = await readHeaderFooterMedia(zip);
    expect(mediaByPart.get('word/header1.xml')).toEqual({
      status: 'relsUnreadable',
      partPath: 'word/header1.xml',
    });
  });

  // INV-1 (#502): a corrupt/undecompressable .rels entry read also degrades
  // to relsUnreadable, never a raw JSZip error and never a throw.
  it('degrades to relsUnreadable for a corrupt/undecompressable .rels entry read, never throwing', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>',
      'word/_rels/header1.xml.rels': relsXml(imageRel('rId1', 'media/image1.png')),
      'word/media/image1.png': new Uint8Array([1]),
    });
    // A rejected read of the .rels part itself (not a media byte fetch,
    // which Promise.allSettled already isolates) degrades the whole part.
    breakFetch(zip, 'word/_rels/header1.xml.rels');
    const mediaByPart = await readHeaderFooterMedia(zip);
    expect(mediaByPart.get('word/header1.xml')).toEqual({
      status: 'relsUnreadable',
      partPath: 'word/header1.xml',
    });
  });

  // INV-9 (#502): a relsUnreadable part never contaminates a sibling part --
  // the sibling header/footer region still resolves its media normally.
  it('isolates a relsUnreadable part from a sibling part -- the sibling header/footer region still resolves normally', async () => {
    const zip = makeZip({
      'word/header1.xml': '<w:hdr/>',
      'word/_rels/header1.xml.rels': '<not valid xml',
      'word/header2.xml': '<w:hdr/>',
      'word/_rels/header2.xml.rels': relsXml(imageRel('rId1', 'media/good.png')),
      'word/media/good.png': new Uint8Array([42]),
    });

    const mediaByPart = await readHeaderFooterMedia(zip);

    expect(mediaByPart.get('word/header1.xml')).toEqual({
      status: 'relsUnreadable',
      partPath: 'word/header1.xml',
    });
    expect(resolvedMedia(mediaByPart, 'word/header2.xml')?.get('rId1')).toEqual(
      new Uint8Array([42])
    );
  });

  it('does not match .rels files outside word/_rels/ or names that merely contain "header"/"footer"', async () => {
    const zip = makeZip({
      'customXml/_rels/header1.xml.rels': relsXml(imageRel('rId1', 'media/image1.png')),
      'word/_rels/header-styles.xml.rels': relsXml(imageRel('rId1', 'media/image1.png')),
      'word/media/image1.png': new Uint8Array([1]),
    });
    const mediaByPart = await readHeaderFooterMedia(zip);
    expect(mediaByPart.size).toBe(0);
  });
});
