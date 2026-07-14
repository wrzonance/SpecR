// src/generator/header-footer-images.ts
// Header/footer image (logo) rendering (#308, ADR-069). Turns an AST `image`
// field's base64 `imageData` into a real docx `ImageRun`, plus the warnings a
// malformed/incomplete/unsupported image field produces — sitting alongside
// the text-field rendering in `header-footer-fields.ts` without growing that
// file past the repo's 400-line cap.

import { ImageRun } from 'docx';
import { sniffImageMediaType, MAX_IMAGE_BYTES } from '../lib/image-media-type.js';
import type { HeaderFooterImageMediaType } from '../lib/image-media-type.js';
import { decodeBase64Payload } from '../lib/decode-base64.js';
import type { HeaderFooterField } from './header-footer-fields.js';

// OOXML DrawingML's native unit is the EMU (English Metric Unit); docx's own
// `ImageRun` transformation option takes pixels instead and converts back to
// EMU internally when it builds `<wp:extent cx="..." cy="..."/>`. 9525 is the
// standard EMU-per-pixel constant (914400 EMU/inch ÷ 96 DPI), not a
// SpecR-invented figure.
const EMU_PER_PIXEL = 9525;

/** docx's `ImageRun` `type` option per media type it can render. */
const DOCX_IMAGE_TYPES: Readonly<
  Record<HeaderFooterImageMediaType, 'png' | 'jpg' | 'gif' | 'bmp'>
> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/** The docx `ImageRun` `type` option for a sniffed media type. Total. */
export function docxImageType(
  mediaType: HeaderFooterImageMediaType
): 'png' | 'jpg' | 'gif' | 'bmp' {
  return DOCX_IMAGE_TYPES[mediaType];
}

/** True iff `field` is an image field carrying image bytes to render. */
export function imageFieldHasContent(field: HeaderFooterField): boolean {
  return field.kind === 'image' && field.imageData !== undefined;
}

/**
 * EMU -> pixel, matching the conversion `renderImageRun` applies to
 * `widthEmu`/`heightEmu`. Pure, total: any finite non-negative `emu` yields a
 * finite non-negative integer (never negative, never `NaN`) — `widthEmu`/
 * `heightEmu` are schema-validated positive integers, so `emu` is never
 * negative in practice, but the rounding itself introduces no sign flip.
 */
function emuToPixels(emu: number): number {
  return Math.round(emu / EMU_PER_PIXEL);
}

/**
 * The decoded image bytes for `field.imageData`, sniffed to a supported media
 * type, or `undefined` when `imageData` is absent, fails to decode, or does
 * not sniff to one of the four types `docx`'s `ImageRun` supports. The single
 * shared decode+sniff step both `renderImageRun` and `unreadableDataWarning`
 * build on, so the two never drift on what counts as "readable".
 */
function decodeAndSniff(
  field: HeaderFooterField
): { readonly buffer: Buffer; readonly mediaType: HeaderFooterImageMediaType } | undefined {
  if (field.imageData === undefined) return undefined;
  const decoded = decodeBase64Payload(field.imageData, MAX_IMAGE_BYTES);
  if ('error' in decoded) return undefined;
  const mediaType = sniffImageMediaType(decoded.buffer);
  if (mediaType === undefined) return undefined;
  return { buffer: decoded.buffer, mediaType };
}

/**
 * Render `field` (an `image`-kind field) to a docx `ImageRun`, or `undefined`
 * when it cannot be rendered: `field.kind !== 'image'`, `imageData` absent,
 * undecodable, or unsniffable, or `widthEmu`/`heightEmu` missing.
 *
 * Pure, total, NEVER THROWS — no try/catch, no logger. `docx`'s `ImageRun`
 * constructor performs no content validation on the image buffer (confirmed:
 * `node_modules/docx`, ADR-069); every reachable failure mode is already
 * excluded by this function's own guard-clause returns before `ImageRun` is
 * ever constructed. The `type` option is always the **sniffed** media type,
 * never `field.imageMediaType` — a stale/mismatched declared type cannot make
 * this emit a `type` that disagrees with the actual bytes.
 */
export function renderImageRun(field: HeaderFooterField): ImageRun | undefined {
  if (field.kind !== 'image') return undefined;
  if (field.widthEmu === undefined || field.heightEmu === undefined) return undefined;
  const sniffed = decodeAndSniff(field);
  if (sniffed === undefined) return undefined;
  const altText =
    field.altText === undefined
      ? {}
      : { altText: { name: field.altText, description: field.altText } };
  return new ImageRun({
    type: docxImageType(sniffed.mediaType),
    data: sniffed.buffer,
    transformation: {
      width: emuToPixels(field.widthEmu),
      height: emuToPixels(field.heightEmu),
    },
    ...altText,
  });
}

/** `undefined` when `field` carries both dimensions; a warning otherwise. */
function missingDimensionsWarning(field: HeaderFooterField): string | undefined {
  if (field.widthEmu !== undefined && field.heightEmu !== undefined) return undefined;
  return 'image field is missing widthEmu/heightEmu and will not render';
}

/**
 * `undefined` when `field.imageData` decodes and sniffs to a supported image
 * type; a warning describing which step failed otherwise.
 */
function unreadableDataWarning(field: HeaderFooterField): string | undefined {
  if (field.imageData === undefined) return undefined;
  const decoded = decodeBase64Payload(field.imageData, MAX_IMAGE_BYTES);
  if ('error' in decoded) return `image data could not be decoded (${decoded.error})`;
  if (sniffImageMediaType(decoded.buffer) === undefined) {
    return 'image data does not match a supported image signature (png/jpeg/gif/bmp)';
  }
  return undefined;
}

/**
 * `undefined` when `field.imageMediaType` is absent, unreadable, or agrees
 * with the sniffed type; a warning when a caller-declared type disagrees with
 * what the bytes actually are.
 */
function mediaTypeMismatchWarning(field: HeaderFooterField): string | undefined {
  if (field.imageMediaType === undefined) return undefined;
  const sniffed = decodeAndSniff(field);
  if (sniffed === undefined || sniffed.mediaType === field.imageMediaType) return undefined;
  return `declared imageMediaType "${field.imageMediaType}" does not match the sniffed type "${sniffed.mediaType}"`;
}

// Catchall keys (ADR-021) an image field can round-trip but this renderer
// does not yet apply.
const UNSUPPORTED_IMAGE_KEYS = ['rotationDegrees', 'flipHorizontal', 'flipVertical'] as const;

/** One warning per unsupported catchall key present on `field`. */
function unsupportedKeyWarnings(field: HeaderFooterField): readonly string[] {
  return UNSUPPORTED_IMAGE_KEYS.filter((key) => field[key] !== undefined).map(
    (key) => `image field key "${key}" is not yet supported and will be ignored`
  );
}

/**
 * Every warning `field` produces, each prefixed with `location` (e.g.
 * `"header.left"`). `[]` when `field.imageData` is absent — nothing was
 * attempted, so nothing to warn about — and also `[]` for a fully valid image
 * field with no dimension/decode/mismatch/unsupported-key issues. Pure, no
 * I/O, never throws.
 */
export function imageFieldWarnings(field: HeaderFooterField, location: string): readonly string[] {
  if (field.imageData === undefined) return [];
  const warnings = [
    missingDimensionsWarning(field),
    unreadableDataWarning(field),
    mediaTypeMismatchWarning(field),
    ...unsupportedKeyWarnings(field),
  ].filter((warning): warning is string => warning !== undefined);
  return warnings.map((warning) => `${location}: ${warning}`);
}
