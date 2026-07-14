import { describe, it, expect } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
import type { HeaderFooterField } from './header-footer-fields.js';
import {
  imageFieldHasContent,
  docxImageType,
  renderImageRun,
  imageFieldWarnings,
} from './header-footer-images.js';

// Minimal real magic-byte signatures, matching src/lib/image-media-type.test.ts's
// fixtures — just the header bytes, no real pixel data, since renderImageRun only
// ever needs the signature to sniff a type.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BASE64 = PNG_BYTES.toString('base64');
const JPEG_BASE64 = JPEG_BYTES.toString('base64');
const UNRECOGNIZED_BASE64 = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64');
const MALFORMED_BASE64 = '***not-base64***';

const VALID_IMAGE_FIELD: HeaderFooterField = {
  kind: 'image',
  imageData: PNG_BASE64,
  widthEmu: 914400, // 1 inch
  heightEmu: 457200, // 0.5 inch
};

/** Render one child to `word/document.xml`'s parsed zip, for media inspection. */
async function renderToZip(child: NonNullable<ReturnType<typeof renderImageRun>>): Promise<JSZip> {
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [child] })] }] });
  return JSZip.loadAsync(await Packer.toBuffer(doc));
}

/** File (not directory) entries under `word/media/`, e.g. `word/media/abc.png`. */
function mediaFileNames(zip: JSZip): readonly string[] {
  return Object.entries(zip.files)
    .filter(([name, entry]) => name.startsWith('word/media/') && !entry.dir)
    .map(([name]) => name);
}

describe('imageFieldHasContent', () => {
  it('is true for an image field with imageData', () => {
    expect(imageFieldHasContent(VALID_IMAGE_FIELD)).toBe(true);
  });

  it('is false for an image field with no imageData', () => {
    expect(imageFieldHasContent({ kind: 'image' })).toBe(false);
  });

  it('is false for a non-image field, even one carrying stray imageData', () => {
    expect(imageFieldHasContent({ kind: 'literal', imageData: PNG_BASE64 })).toBe(false);
  });
});

describe('docxImageType', () => {
  it('maps every HeaderFooterImageMediaType to the docx ImageRun type it corresponds to', () => {
    expect(docxImageType('image/png')).toBe('png');
    expect(docxImageType('image/jpeg')).toBe('jpg');
    expect(docxImageType('image/gif')).toBe('gif');
    expect(docxImageType('image/bmp')).toBe('bmp');
  });
});

describe('renderImageRun — pure and total, never throws', () => {
  const cases: readonly { readonly label: string; readonly field: HeaderFooterField }[] = [
    { label: 'non-image kind', field: { kind: 'literal', text: 'x' } },
    { label: 'image kind, no imageData', field: { kind: 'image' } },
    {
      label: 'image kind, malformed base64',
      field: { kind: 'image', imageData: MALFORMED_BASE64, widthEmu: 100, heightEmu: 100 },
    },
    {
      label: 'image kind, valid base64 but unsniffable signature',
      field: { kind: 'image', imageData: UNRECOGNIZED_BASE64, widthEmu: 100, heightEmu: 100 },
    },
    {
      label: 'image kind, valid signature, missing widthEmu',
      field: { kind: 'image', imageData: PNG_BASE64, heightEmu: 100 },
    },
    {
      label: 'image kind, valid signature, missing heightEmu',
      field: { kind: 'image', imageData: PNG_BASE64, widthEmu: 100 },
    },
    {
      label: 'image kind, valid signature, missing both dimensions',
      field: { kind: 'image', imageData: PNG_BASE64 },
    },
    { label: 'fully valid image field', field: VALID_IMAGE_FIELD },
  ];

  it.each(cases)('does not throw for: $label', ({ field }) => {
    expect(() => renderImageRun(field)).not.toThrow();
  });

  it('returns undefined for a non-image field', () => {
    expect(renderImageRun({ kind: 'literal', text: 'x' })).toBeUndefined();
  });

  it('returns undefined when imageData is absent', () => {
    expect(renderImageRun({ kind: 'image' })).toBeUndefined();
  });

  it('returns undefined for malformed base64', () => {
    expect(
      renderImageRun({ kind: 'image', imageData: MALFORMED_BASE64, widthEmu: 100, heightEmu: 100 })
    ).toBeUndefined();
  });

  it('returns undefined for well-formed base64 that does not sniff to a supported image type', () => {
    expect(
      renderImageRun({
        kind: 'image',
        imageData: UNRECOGNIZED_BASE64,
        widthEmu: 100,
        heightEmu: 100,
      })
    ).toBeUndefined();
  });

  it('returns undefined when widthEmu or heightEmu is missing', () => {
    expect(
      renderImageRun({ kind: 'image', imageData: PNG_BASE64, heightEmu: 100 })
    ).toBeUndefined();
    expect(renderImageRun({ kind: 'image', imageData: PNG_BASE64, widthEmu: 100 })).toBeUndefined();
    expect(renderImageRun({ kind: 'image', imageData: PNG_BASE64 })).toBeUndefined();
  });

  it('returns a real ImageRun for a fully valid image field', () => {
    expect(renderImageRun(VALID_IMAGE_FIELD)).toBeDefined();
  });

  // Regression (#308): a realistically-sized, fully valid, schema-accepted
  // image (well under MAX_IMAGE_BYTES) threw RangeError('Maximum call stack
  // size exceeded') — decodeBase64Payload's base64 validity check used a
  // regex whose grouped quantifier recurses once per 4-char group, blowing
  // the JS stack on a multi-megabyte payload. A real firm/client logo is
  // routinely in this size range.
  it('does not throw for a realistically-sized valid image (regression: stack overflow)', () => {
    // Real PNG signature followed by several MB of filler bytes — large
    // enough to have crashed the old base64 validator, still well under
    // MAX_IMAGE_BYTES (5 MB decoded).
    const largePng = Buffer.concat([PNG_BYTES, Buffer.alloc(4 * 1024 * 1024, 0x00)]);
    const field: HeaderFooterField = {
      kind: 'image',
      imageData: largePng.toString('base64'),
      widthEmu: 914400,
      heightEmu: 457200,
    };
    expect(() => renderImageRun(field)).not.toThrow();
    expect(renderImageRun(field)).toBeDefined();
    expect(() => imageFieldWarnings(field, 'header.left')).not.toThrow();
    expect(imageFieldWarnings(field, 'header.left')).toEqual([]);
  });
});

describe('renderImageRun — chosen type is always the sniffed type, never the declared imageMediaType', () => {
  it('renders PNG bytes as png even when imageMediaType falsely declares jpeg', async () => {
    const run = renderImageRun({
      kind: 'image',
      imageData: PNG_BASE64,
      imageMediaType: 'image/jpeg',
      widthEmu: 914400,
      heightEmu: 457200,
    });
    expect(run).toBeDefined();
    const zip = await renderToZip(run!);
    const mediaNames = mediaFileNames(zip);
    expect(mediaNames).toHaveLength(1);
    expect(mediaNames[0]).toMatch(/\.png$/);
  });

  it('renders JPEG bytes as jpg even when imageMediaType is absent', async () => {
    const run = renderImageRun({
      kind: 'image',
      imageData: JPEG_BASE64,
      widthEmu: 914400,
      heightEmu: 457200,
    });
    expect(run).toBeDefined();
    const zip = await renderToZip(run!);
    const mediaNames = mediaFileNames(zip);
    expect(mediaNames[0]).toMatch(/\.jpg$/);
  });

  it('renders JPEG bytes as jpg even when imageMediaType declares an unsupported type entirely', async () => {
    const run = renderImageRun({
      kind: 'image',
      imageData: JPEG_BASE64,
      imageMediaType: 'image/svg+xml',
      widthEmu: 914400,
      heightEmu: 457200,
    });
    expect(run).toBeDefined();
    const zip = await renderToZip(run!);
    const mediaNames = mediaFileNames(zip);
    expect(mediaNames[0]).toMatch(/\.jpg$/);
  });
});

describe('renderImageRun — EMU to pixel transformation is pure, deterministic, total, never negative/NaN', () => {
  // [widthEmu, heightEmu, expectedCx, expectedCy] — expectedCx/expectedCy are
  // the <wp:extent> values docx writes to word/document.xml after emuToPixels'
  // round(emu / 9525) conversion and docx's own px*9525 re-encoding. Computed
  // independently of the formula under test (not re-derived with the same
  // `/ 9525` division here) so a broken/NaN/negative conversion is actually
  // caught by a value mismatch — a prior version of this test only asserted
  // "does not throw" / "is defined", which passes even for a silently wrong
  // (but still non-throwing, still-defined) pixel value.
  const emuCases: readonly [number, number, number, number][] = [
    [9525, 9525, 9525, 9525], // exactly 1px x 1px, round-trips exactly
    [1, 1, 0, 0], // rounds down to 0px — never negative, never NaN
    [914400, 457200, 914400, 457200], // 1in x 0.5in: 96px x 48px, round-trips exactly
    [100000, 200000, 95250, 200025], // rounds to 10px x 21px, does not round-trip exactly
    // Number.MAX_SAFE_INTEGER / 9525 = 945637717033.4986... rounds to
    // 945637717033px; re-encoded (px * 9525) is one ULP-scale value below the
    // original EMU — still finite, still positive, never NaN.
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 9007199254739325, 9007199254739325],
  ];

  it.each(emuCases)(
    'widthEmu=%d heightEmu=%d converts to the documented cx/cy, never NaN/negative',
    async (widthEmu, heightEmu, expectedCx, expectedCy) => {
      const run = renderImageRun({ ...VALID_IMAGE_FIELD, widthEmu, heightEmu });
      expect(run).toBeDefined();
      const zip = await renderToZip(run!);
      const xml = await zip.file('word/document.xml')!.async('string');
      expect(xml).toMatch(new RegExp(`cx="${expectedCx}"`));
      expect(xml).toMatch(new RegExp(`cy="${expectedCy}"`));
    }
  );
});

describe('renderImageRun — altText carries full a11y metadata (name/title/descr) (#308)', () => {
  it('writes the field altText into wp:docPr name, title, and descr', async () => {
    const run = renderImageRun({ ...VALID_IMAGE_FIELD, altText: 'ACME logo' });
    expect(run).toBeDefined();
    const zip = await renderToZip(run!);
    const xml = await zip.file('word/document.xml')!.async('string');
    const docPr = /<wp:docPr[^>]*\/?>/.exec(xml)?.[0] ?? '';
    expect(docPr).toContain('name="ACME logo"');
    expect(docPr).toContain('title="ACME logo"');
    expect(docPr).toContain('descr="ACME logo"');
  });

  it('leaves the a11y attributes empty when the field carries no altText', async () => {
    // docx always writes name/title/descr; with no altText they stay empty
    // strings rather than leaking a stray value.
    const run = renderImageRun(VALID_IMAGE_FIELD);
    expect(run).toBeDefined();
    const zip = await renderToZip(run!);
    const xml = await zip.file('word/document.xml')!.async('string');
    const docPr = /<wp:docPr[^>]*\/?>/.exec(xml)?.[0] ?? '';
    expect(docPr).toContain('title=""');
    expect(docPr).toContain('descr=""');
  });
});

describe('imageFieldWarnings', () => {
  it('returns [] when imageData is absent, regardless of field kind', () => {
    expect(imageFieldWarnings({ kind: 'image' }, 'header.left')).toEqual([]);
    expect(imageFieldWarnings({ kind: 'literal', text: 'x' }, 'header.left')).toEqual([]);
    expect(imageFieldWarnings({ kind: 'pageNumber' }, 'header.left')).toEqual([]);
  });

  it('returns [] for a non-image field, even one carrying stray imageData that would otherwise warn', () => {
    // Mirrors imageFieldHasContent's "stray imageData" case: HeaderFooterField
    // is not a discriminated union at the schema level, so a non-image kind can
    // carry an imageData/widthEmu-shaped payload. It must never be treated as an
    // image field just because imageData is present.
    expect(
      imageFieldWarnings({ kind: 'literal', text: 'x', imageData: MALFORMED_BASE64 }, 'header.left')
    ).toEqual([]);
  });

  it('returns [] for a fully valid image field (no dimension/decode/mismatch/unsupported-key issues)', () => {
    expect(imageFieldWarnings(VALID_IMAGE_FIELD, 'header.left')).toEqual([]);
  });

  it('warns when dimensions are missing', () => {
    const warnings = imageFieldWarnings({ kind: 'image', imageData: PNG_BASE64 }, 'header.left');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('header.left'))).toBe(true);
  });

  it('warns when imageData is malformed base64', () => {
    const warnings = imageFieldWarnings(
      { kind: 'image', imageData: MALFORMED_BASE64, widthEmu: 100, heightEmu: 100 },
      'footer.center'
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('warns when imageData is well-formed base64 but does not sniff to a supported type', () => {
    const warnings = imageFieldWarnings(
      { kind: 'image', imageData: UNRECOGNIZED_BASE64, widthEmu: 100, heightEmu: 100 },
      'footer.center'
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('warns when the declared imageMediaType disagrees with the sniffed type', () => {
    const warnings = imageFieldWarnings(
      {
        kind: 'image',
        imageData: PNG_BASE64,
        imageMediaType: 'image/jpeg',
        widthEmu: 100,
        heightEmu: 100,
      },
      'header.right'
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not warn about a mismatch when the declared type matches the sniffed type', () => {
    const warnings = imageFieldWarnings(
      {
        kind: 'image',
        imageData: PNG_BASE64,
        imageMediaType: 'image/png',
        widthEmu: 100,
        heightEmu: 100,
      },
      'header.right'
    );
    expect(warnings).toEqual([]);
  });

  it.each(['rotationDegrees', 'flipHorizontal', 'flipVertical'] as const)(
    'warns about the unsupported catchall key %s',
    (key) => {
      const field: HeaderFooterField = { ...VALID_IMAGE_FIELD, [key]: true };
      const warnings = imageFieldWarnings(field, 'header.left');
      expect(warnings.some((w) => w.includes(key))).toBe(true);
    }
  );

  it('every returned warning is prefixed with the given location', () => {
    const warnings = imageFieldWarnings({ kind: 'image', imageData: PNG_BASE64 }, 'footer.right');
    for (const warning of warnings) {
      expect(warning.startsWith('footer.right')).toBe(true);
    }
  });

  it('accumulates multiple independent warnings for a field with multiple problems', () => {
    const warnings = imageFieldWarnings(
      {
        kind: 'image',
        imageData: PNG_BASE64,
        imageMediaType: 'image/jpeg',
        rotationDegrees: 90,
        // widthEmu/heightEmu both absent
      },
      'header.left'
    );
    // missing dimensions + declared/sniffed mismatch + unsupported key = 3 independent issues
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});

// Regression (#308): MAX_IMAGE_BASE64_LENGTH is a length-only pre-filter, so it
// cannot distinguish a correctly-padded MAX_IMAGE_BYTES-byte encoding from an
// unpadded (MAX_IMAGE_BYTES + 1)-byte one at the same string length — the AST
// schema's `.refine()` accepts both (see header-footer-schemas.test.ts's "exactly
// at the cap" test). This end-to-end case pins that the *generator* still never
// silently renders the over-cap one: decodeBase64Payload's exact, padding-aware
// check drops it with a warning, same as any other unreadable image.
describe('renderImageRun/imageFieldWarnings — MAX_IMAGE_BASE64_LENGTH boundary is closed at decode time', () => {
  // All-'A' is valid base64 alphabet with no '=' padding, so at exactly
  // MAX_IMAGE_BASE64_LENGTH chars it decodes to MAX_IMAGE_BYTES + 1 bytes —
  // schema-length-acceptable, but one byte over the real cap.
  const oversizedAtSchemaBoundary: HeaderFooterField = {
    kind: 'image',
    imageData: 'A'.repeat(MAX_IMAGE_BASE64_LENGTH),
    widthEmu: 914400,
    heightEmu: 457200,
  };

  it('renderImageRun does not throw and does not render the over-cap image', () => {
    expect(() => renderImageRun(oversizedAtSchemaBoundary)).not.toThrow();
    expect(renderImageRun(oversizedAtSchemaBoundary)).toBeUndefined();
  });

  it('imageFieldWarnings reports the decode-time size rejection, never silently drops it', () => {
    const warnings = imageFieldWarnings(oversizedAtSchemaBoundary, 'header.left');
    expect(warnings.some((w) => w.includes('could not be decoded'))).toBe(true);
  });
});
