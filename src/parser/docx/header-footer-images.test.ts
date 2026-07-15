import { describe, it, expect } from 'vitest';
import { asRecord, createDocumentXmlParser } from './xml-utils.js';
import { MAX_IMAGE_BYTES } from '../../lib/image-media-type.js';
import { parseDrawingDescriptor, resolveDrawingImage } from './header-footer-images.js';

// Real fast-xml-parser output, not hand-mocked records (spike-confirmed
// posture, see the "unprefixed vs prefixed attribute" comments in
// header-footer-images.ts) — mirrors header-footer-region.test.ts's own
// XML-string-fixture style. No isArray tags are needed: every element in
// these fixtures occurs at most once per parent EXCEPT the KNOWN AMBIGUITY
// fixture below, which relies on fast-xml-parser's own auto-arrayify
// behavior for a genuinely repeated `w:drawing` sibling.
const partParser = createDocumentXmlParser([]);

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
].join(' ');

function parseRun(xml: string): Record<string, unknown> {
  const parsed = partParser.parse(xml) as Record<string, unknown>;
  const run = asRecord(parsed['w:r']);
  if (!run) throw new Error('test fixture parse failure: no w:r root');
  return run;
}

function runWithDrawings(...drawingInnerXmls: readonly string[]): Record<string, unknown> {
  const drawings = drawingInnerXmls.map((inner) => `<w:drawing>${inner}</w:drawing>`).join('');
  return parseRun(`<w:r ${NS}>${drawings}</w:r>`);
}

function extentXml(cx: string, cy: string): string {
  return `<wp:extent cx="${cx}" cy="${cy}"/>`;
}

function docPrXml(attrs: string): string {
  return `<wp:docPr id="1" ${attrs}/>`;
}

function blipXml(rEmbedOrLink: 'embed' | 'link' | 'none', rId: string): string {
  if (rEmbedOrLink === 'none') return '<a:blip/>';
  return `<a:blip r:${rEmbedOrLink}="${rId}"/>`;
}

function picChainXml(blip: string): string {
  return `<a:graphic><a:graphicData><pic:pic><pic:blipFill>${blip}</pic:blipFill></pic:pic></a:graphicData></a:graphic>`;
}

// A chart's graphicData genuinely has no pic:pic child — hand-built per the
// design's spike finding (chart/smartart/group-shape drawings are not
// hypothetical), not a synthetic edge case.
function chartGraphicDataXml(): string {
  return (
    '<a:graphic>' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart r:id="rId9"/>' +
    '</a:graphicData>' +
    '</a:graphic>'
  );
}

function inlineDrawing(bodyXml: string): Record<string, unknown> {
  return runWithDrawings(`<wp:inline>${bodyXml}</wp:inline>`);
}

function anchorDrawing(bodyXml: string): Record<string, unknown> {
  return runWithDrawings(`<wp:anchor>${bodyXml}</wp:anchor>`);
}

function wellFormedDrawing(
  rId: string,
  cx: string,
  cy: string,
  docPrAttrs: string
): Record<string, unknown> {
  return inlineDrawing(
    extentXml(cx, cy) + docPrXml(docPrAttrs) + picChainXml(blipXml('embed', rId))
  );
}

// ─── magic-byte fixtures (real signatures sniffImageMediaType recognizes) ──

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GARBAGE_BYTES = [0x00, 0x01, 0x02, 0x03];

function bytesOf(signature: readonly number[], totalLength: number): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  bytes.set(signature);
  return bytes;
}

function pngBytes(totalLength = 16): Uint8Array {
  return bytesOf(PNG_SIGNATURE, totalLength);
}

function jpegBytes(totalLength = 16): Uint8Array {
  return bytesOf(JPEG_SIGNATURE, totalLength);
}

describe('parseDrawingDescriptor — structural walk, before any byte resolution', () => {
  it('extracts rId, EMU size, and alt text (descr) from a well-formed wp:inline pic:pic drawing', () => {
    const run = wellFormedDrawing(
      'rId5',
      '914400',
      '609600',
      'name="Picture 1" descr="Company logo"'
    );
    expect(parseDrawingDescriptor(run)).toEqual({
      rId: 'rId5',
      widthEmu: 914400,
      heightEmu: 609600,
      altText: 'Company logo',
    });
  });

  it('extracts from a wp:anchor container the same way as wp:inline', () => {
    const run = anchorDrawing(
      extentXml('100000', '200000') +
        docPrXml('name="Anchored"') +
        picChainXml(blipXml('embed', 'rId7'))
    );
    expect(parseDrawingDescriptor(run)).toEqual({
      rId: 'rId7',
      widthEmu: 100000,
      heightEmu: 200000,
      altText: 'Anchored',
    });
  });

  it('falls back to docPr name when descr is absent', () => {
    const run = wellFormedDrawing('rId1', '100000', '100000', 'name="Fallback Name"');
    expect(parseDrawingDescriptor(run)?.altText).toBe('Fallback Name');
  });

  it('omits altText entirely when both descr and name are absent', () => {
    const run = inlineDrawing(
      extentXml('100000', '100000') + docPrXml('') + picChainXml(blipXml('embed', 'rId1'))
    );
    const descriptor = parseDrawingDescriptor(run);
    expect(descriptor).toBeDefined();
    expect('altText' in (descriptor ?? {})).toBe(false);
  });

  it('returns undefined for a run with no w:drawing at all', () => {
    const run = parseRun(`<w:r ${NS}><w:t>plain text</w:t></w:r>`);
    expect(parseDrawingDescriptor(run)).toBeUndefined();
  });

  it('returns undefined when graphicData has no pic:pic chain (chart/smartart/group-shape drawing)', () => {
    const run = inlineDrawing(
      extentXml('100000', '100000') + docPrXml('name="Chart 1"') + chartGraphicDataXml()
    );
    expect(parseDrawingDescriptor(run)).toBeUndefined();
  });

  it('returns undefined when the blip carries only r:link (external/linked image, no embedded rId)', () => {
    const run = wellFormedDrawing('unused', '100000', '100000', 'name="Linked"');
    const linkedRun = inlineDrawing(
      extentXml('100000', '100000') +
        docPrXml('name="Linked"') +
        picChainXml(blipXml('link', 'rId3'))
    );
    expect(parseDrawingDescriptor(linkedRun)).toBeUndefined();
    // sanity: the embed variant of the exact same shape DOES resolve
    expect(parseDrawingDescriptor(run)?.rId).toBe('unused');
  });

  it('returns undefined when wp:extent is entirely missing', () => {
    const run = inlineDrawing(docPrXml('name="No size"') + picChainXml(blipXml('embed', 'rId1')));
    expect(parseDrawingDescriptor(run)).toBeUndefined();
  });

  it('returns undefined when cx/cy are zero or negative', () => {
    const zero = wellFormedDrawing('rId1', '0', '100000', '');
    const negative = wellFormedDrawing('rId1', '100000', '-5', '');
    expect(parseDrawingDescriptor(zero)).toBeUndefined();
    expect(parseDrawingDescriptor(negative)).toBeUndefined();
  });

  it('returns undefined when cx/cy are unparseable', () => {
    const run = wellFormedDrawing('rId1', 'not-a-number', '100000', '');
    expect(parseDrawingDescriptor(run)).toBeUndefined();
  });

  it('returns undefined for a partially numeric EMU with suffix garbage (parseInt would accept "914400px")', () => {
    const trailingUnits = wellFormedDrawing('rId1', '914400px', '609600', '');
    const exponent = wellFormedDrawing('rId1', '1e5', '609600', '');
    expect(parseDrawingDescriptor(trailingUnits)).toBeUndefined();
    expect(parseDrawingDescriptor(exponent)).toBeUndefined();
  });

  it('never falls back to a:xfrm/a:ext sizing when wp:extent is absent', () => {
    const run = inlineDrawing(
      '<a:xfrm><a:ext cx="500000" cy="500000"/></a:xfrm>' +
        docPrXml('name="xfrm only"') +
        picChainXml(blipXml('embed', 'rId1'))
    );
    expect(parseDrawingDescriptor(run)).toBeUndefined();
  });

  it('KNOWN AMBIGUITY: a run with two w:drawing children resolves neither (w:drawing is absent from every isArrayTags list — a single drawing parses as a plain object, but fast-xml-parser auto-arrayifies the repeated sibling regardless, and this walk cannot descend into that array)', () => {
    const first = `<wp:inline>${extentXml('100000', '100000')}${picChainXml(blipXml('embed', 'rId1'))}</wp:inline>`;
    const second = `<wp:inline>${extentXml('200000', '200000')}${picChainXml(blipXml('embed', 'rId2'))}</wp:inline>`;
    const run = runWithDrawings(first, second);
    expect(parseDrawingDescriptor(run)).toBeUndefined();
  });
});

describe('resolveDrawingImage — byte resolution, sniff, size cap (ADR-068: never fail capture)', () => {
  it('invariant: imageMediaType on a captured field is always the SNIFFED type, never inferred from anywhere else', () => {
    const run = wellFormedDrawing('rId1', '100000', '100000', '');
    const pngResult = resolveDrawingImage(run, new Map([['rId1', pngBytes()]]));
    const jpegResult = resolveDrawingImage(run, new Map([['rId1', jpegBytes()]]));
    expect(pngResult.kind === 'field' && pngResult.field.imageMediaType).toBe('image/png');
    expect(jpegResult.kind === 'field' && jpegResult.field.imageMediaType).toBe('image/jpeg');
  });

  it('invariant: unsniffable bytes never produce a field, even with a fully valid descriptor (#306 regression guard)', () => {
    const run = wellFormedDrawing('rId1', '100000', '100000', '');
    const result = resolveDrawingImage(run, new Map([['rId1', new Uint8Array(GARBAGE_BYTES)]]));
    expect(result.kind).toBe('unmodeled');
  });

  it('invariant: widthEmu/heightEmu on a captured field are the verbatim wp:extent cx/cy ints — no unit conversion', () => {
    const run = wellFormedDrawing('rId1', '914400', '1828800', '');
    const result = resolveDrawingImage(run, new Map([['rId1', pngBytes()]]));
    expect(result.kind === 'field' && result.field.widthEmu).toBe(914400);
    expect(result.kind === 'field' && result.field.heightEmu).toBe(1828800);
  });

  it('invariant: the MAX_IMAGE_BYTES cap runs on raw decoded bytes, before base64 encoding and before any field is built', () => {
    const run = wellFormedDrawing('rId1', '100000', '100000', '');
    const oversize = pngBytes(MAX_IMAGE_BYTES + 1);
    const result = resolveDrawingImage(run, new Map([['rId1', oversize]]));
    expect(result.kind).toBe('unmodeled');
  });

  it('accepts bytes exactly at the MAX_IMAGE_BYTES cap (boundary, not off-by-one)', () => {
    const run = wellFormedDrawing('rId1', '100000', '100000', '');
    const atCap = pngBytes(MAX_IMAGE_BYTES);
    const result = resolveDrawingImage(run, new Map([['rId1', atCap]]));
    expect(result.kind).toBe('field');
  });

  it('falls back to unmodeled when parseDrawingDescriptor finds no descriptor', () => {
    const run = parseRun(`<w:r ${NS}><w:t>plain text</w:t></w:r>`);
    const result = resolveDrawingImage(run, new Map([['rId1', pngBytes()]]));
    expect(result.kind).toBe('unmodeled');
    expect(result.kind === 'unmodeled' && result.entry.kind).toBe('image');
  });

  it('falls back to unmodeled when mediaByRId has no entry for the descriptor rId', () => {
    const run = wellFormedDrawing('rId1', '100000', '100000', '');
    expect(resolveDrawingImage(run, new Map([['rId-other', pngBytes()]])).kind).toBe('unmodeled');
  });

  it('falls back to unmodeled when mediaByRId itself is undefined (no image relationships for the part)', () => {
    const run = wellFormedDrawing('rId1', '100000', '100000', '');
    expect(resolveDrawingImage(run, undefined).kind).toBe('unmodeled');
  });

  it('builds a byte-identical base64 round trip of the accepted bytes on success', () => {
    const run = wellFormedDrawing('rId1', '100000', '100000', 'descr="Logo"');
    const bytes = pngBytes(32);
    const result = resolveDrawingImage(run, new Map([['rId1', bytes]]));
    expect(result.kind).toBe('field');
    const field = result.kind === 'field' ? result.field : undefined;
    expect(field?.imageData).toBe(Buffer.from(bytes).toString('base64'));
    expect(Buffer.from(field?.imageData ?? '', 'base64')).toEqual(Buffer.from(bytes));
    expect(field).toEqual({
      kind: 'image',
      imageData: Buffer.from(bytes).toString('base64'),
      imageMediaType: 'image/png',
      widthEmu: 100000,
      heightEmu: 100000,
      altText: 'Logo',
    });
  });
});
