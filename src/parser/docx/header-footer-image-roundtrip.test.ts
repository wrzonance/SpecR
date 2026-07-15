import { describe, it, expect } from 'vitest';
import { Document, Packer } from 'docx';
import type { Header } from 'docx';
import JSZip from 'jszip';
import { captureRegion } from './header-footer-region.js';
import type { HeaderFooterRegion } from './header-footer-region.js';
import { compact } from './xml-utils.js';
import { renderHeaderFooterComposition } from '../../generator/index.js';
import type { HeaderFooterFieldContext } from '../../generator/index.js';
import type { HeaderFooterComposition } from '../../ast/index.js';

// #487 (task 7/8) — a true cross-module round-trip for the drawing-image
// pipeline, mirroring header-footer-table-roundtrip.test.ts's own table
// round-trip (#309): a real w:drawing run captured off raw OOXML by the
// PARSER's captureRegion (resolveDrawingImage/parseDrawingDescriptor,
// header-footer-images.ts) feeds directly into the GENERATOR's
// renderHeaderFooterComposition, which routes the image field through the
// FROZEN renderImageRun (ADR-069) -- packed via a real docx Packer and
// reopened via JSZip. Every other #487 suite tests one side of this boundary
// in isolation (header-footer-images.test.ts pins parseDrawingDescriptor/
// resolveDrawingImage against hand-built records; header-footer-region.test.ts
// pins the wiring into captureRegion; the generator's own
// header-footer-images.test.ts pins renderImageRun against a hand-built
// field). This file is what proves acceptance criterion 2 end to end: the
// media bytes docx actually writes into word/media/*.png are byte-identical
// to the source bytes, and the <wp:extent> cx/cy docx actually writes into
// word/header1.xml survive the EMU -> px (renderImageRun) -> EMU (docx's own
// Packer) round trip unchanged.
//
// Per CLAUDE.md's module-boundary rule, this file lives in src/parser/docx/
// (same directory as captureRegion/compact) and reaches the generator only
// through its public barrel (../../generator/index.js), never a generator
// internal -- renderImageRun itself is exercised transitively, exactly the
// way a real DOCX generation request would reach it.

const KNOWN = { section: '09 91 26', title: 'EXTERIOR PAINTING' };

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const CTX: HeaderFooterFieldContext = {
  sectionNumber: '23 05 00',
  sectionTitle: 'EXTERIOR PAINTING',
  current: {},
};

// 914400/609600 EMU (1in x 2/3in at 96dpi) are exact multiples of 9525 -- the
// standard EMU-per-pixel constant (914400 EMU/inch / 96 DPI) documented at
// the top of both generator/header-footer-images.ts and this file's own
// assertions below, and independently confirmed against node_modules/docx's
// own px -> EMU packing (`Math.round(width * 9525)`, dist/index.mjs). A
// round multiple means the EMU -> px -> EMU round trip is LOSSLESS -- the
// packed cx/cy must recover the originals exactly, not merely approximately.
const WIDTH_EMU = 914400;
const HEIGHT_EMU = 609600;
const EMU_PER_PIXEL = 9525;
const EXPECTED_WIDTH_PX = 96;
const EXPECTED_HEIGHT_PX = 64;

function makeHdrXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${bodyXml}</w:hdr>`;
}

function paragraph(runsXml: string): string {
  return `<w:p>${runsXml}</w:p>`;
}

// Mirrors header-footer-region.test.ts's own imageDrawingRun fixture (same
// well-formed wp:inline/pic:pic/a:blip shape, same rId-parameterized call
// site) -- captureRegion's own real input shape, not a pre-parsed record.
function imageDrawingRun(rId: string): string {
  return (
    '<w:r><w:drawing><wp:inline>' +
    `<wp:extent cx="${WIDTH_EMU}" cy="${HEIGHT_EMU}"/>` +
    '<wp:docPr id="1" name="Logo" descr="Company logo"/>' +
    '<a:graphic><a:graphicData><pic:pic><pic:blipFill>' +
    `<a:blip r:embed="${rId}"/>` +
    '</pic:blipFill></pic:pic></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r>'
  );
}

// A real, decodable PNG-signature byte buffer with non-repeating content
// past the 8-byte magic number (unlike header-footer-images.test.ts's
// all-zero-fill pngBytes helper) -- a truncation/offset bug anywhere in the
// byte pipeline would silently pass an all-zero-content fixture of the same
// length but fail this one.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function fakePngBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(PNG_SIGNATURE);
  for (let i = PNG_SIGNATURE.length; i < length; i++) bytes[i] = i % 256;
  return bytes;
}

// Mirrors header-footer-table-roundtrip.test.ts's own compositionWithHeader/
// docWithHeader idiom verbatim.
function compositionWithHeader(region: HeaderFooterRegion | undefined): HeaderFooterComposition {
  return compact({ header: region }) as HeaderFooterComposition;
}

function docWithHeader(headers: Partial<Record<'default', Header>> | undefined): Document {
  return new Document({
    sections: [{ ...(headers !== undefined ? { headers } : {}), children: [] }],
  });
}

async function packedZip(composition: HeaderFooterComposition): Promise<JSZip> {
  const result = renderHeaderFooterComposition(composition, CTX);
  const buffer = await Packer.toBuffer(docWithHeader(result.headers));
  return JSZip.loadAsync(buffer);
}

function onlyMediaFile(zip: JSZip): JSZip.JSZipObject {
  const mediaFiles = zip.file(/^word\/media\//);
  if (mediaFiles.length !== 1) {
    throw new Error(
      `test setup: expected exactly one word/media/* entry in the packed DOCX, found ${mediaFiles.length}`
    );
  }
  const [mediaFile] = mediaFiles;
  if (!mediaFile) throw new Error('test setup: word/media/* lookup failed');
  return mediaFile;
}

// Tolerant of attribute order/self-closing-tag formatting -- extracts the
// cx/cy pair from whichever <wp:extent .../> tag docx's own XML builder
// emitted, rather than asserting on its exact serialization.
function extentEmu(headerXml: string): { readonly cx: number; readonly cy: number } {
  const tag = /<wp:extent\b[^>]*>/.exec(headerXml)?.[0];
  if (!tag) throw new Error('test setup: no <wp:extent> found in packed word/header1.xml');
  const cx = /\bcx="(\d+)"/.exec(tag)?.[1];
  const cy = /\bcy="(\d+)"/.exec(tag)?.[1];
  if (!cx || !cy) throw new Error('test setup: <wp:extent> is missing cx/cy attributes');
  return { cx: Number(cx), cy: Number(cy) };
}

describe('captureRegion -> renderHeaderFooterComposition -> Packer -> JSZip drawing-image round-trip (#487)', () => {
  it('carries a captured drawing image, byte-identical media + lossless EMU/px sizing, into a real packed DOCX', async () => {
    const originalBytes = fakePngBytes(64);
    const xml = makeHdrXml(paragraph(imageDrawingRun('rId9')));
    const mediaByRId = new Map([['rId9', originalBytes]]);

    const captured = captureRegion(xml, 'bottom', 'default', 'header', KNOWN, mediaByRId);
    expect(captured.unmodeled).toEqual([]);
    expect(captured.region?.left?.content).toEqual([
      {
        kind: 'image',
        imageData: Buffer.from(originalBytes).toString('base64'),
        imageMediaType: 'image/png',
        widthEmu: WIDTH_EMU,
        heightEmu: HEIGHT_EMU,
        altText: 'Company logo',
      },
    ]);
    // Sanity check on the captured field alone, BEFORE the generator is
    // even invoked -- parser-side base64 fidelity is already pinned in
    // header-footer-images.test.ts. What this file adds below is proof that
    // the FROZEN generator's renderImageRun preserves it too, all the way
    // through a real Packer/JSZip round trip.
    const field = captured.region?.left?.content?.[0];
    expect(Buffer.from(field?.imageData ?? '', 'base64')).toEqual(Buffer.from(originalBytes));

    const zip = await packedZip(compositionWithHeader(captured.region));

    const mediaFile = onlyMediaFile(zip);
    expect(mediaFile.name).toMatch(/\.png$/);
    const packedMediaBytes = new Uint8Array(await mediaFile.async('nodebuffer'));
    expect(packedMediaBytes).toEqual(originalBytes);

    const headerFile = zip.file('word/header1.xml');
    if (!headerFile) throw new Error('test setup: word/header1.xml missing from packed DOCX');
    const headerXml = await headerFile.async('string');
    expect(headerXml).toContain('descr="Company logo"');

    // The full round trip: source EMU -> renderImageRun's px transformation
    // (Math.round(emu / 9525)) -> docx's own px -> EMU re-encoding
    // (Math.round(px * 9525), confirmed in node_modules/docx's ImageRun).
    // WIDTH_EMU/HEIGHT_EMU are exact multiples of 9525, so this trip is
    // LOSSLESS -- the packed cx/cy must equal the originals exactly, and
    // dividing them by the same public 9525 constant must recover the exact
    // pixel dimensions renderImageRun computed along the way.
    const { cx, cy } = extentEmu(headerXml);
    expect(cx).toBe(WIDTH_EMU);
    expect(cy).toBe(HEIGHT_EMU);
    expect(cx / EMU_PER_PIXEL).toBe(EXPECTED_WIDTH_PX);
    expect(cy / EMU_PER_PIXEL).toBe(EXPECTED_HEIGHT_PX);
  });
});
