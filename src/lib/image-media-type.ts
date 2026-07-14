// src/lib/image-media-type.ts
// Format-agnostic magic-byte sniffing for header/footer image content (#308,
// ADR-069). Rendering must never trust a caller-declared media type — a stale or
// mislabeled `imageMediaType` on the AST field could otherwise make the generator
// emit a docx `ImageRun` `type` option that disagrees with the actual bytes, which
// produces a corrupt .docx Word refuses to open. Reading the signature is the only
// trustworthy source of truth for what `docx`'s `ImageRun` can actually decode.
//
// Deliberately scoped to the four raster types `docx`'s `ImageRun` supports —
// `image/svg+xml` and other vector/unsupported formats sniff to `undefined` and are
// treated as undecodable by the caller, not as an error here.

/** The only media types `docx`'s `ImageRun` can render. */
export type HeaderFooterImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/bmp';

/** Decoded-byte cap for a header/footer image — generous for a firm/client logo. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Base64-*string*-length cap corresponding to `MAX_IMAGE_BYTES`, used by the AST
 * schema's `.refine()` so an oversized `imageData` payload is rejected by Zod before
 * any buffer is materialized — the same encoded-length-first posture
 * `decodeBase64Payload` (`./decode-base64.js`) already uses for MCP file payloads.
 * Base64 inflates 3 raw bytes into 4 encoded chars, rounded up to a full 4-char group.
 */
export const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const GIF87A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const;
const GIF89A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const;
const BMP_SIGNATURE = [0x42, 0x4d] as const;

/** Pure — true when `bytes` starts with every byte of `signature`, in order. */
function matchesSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((expected, i) => bytes[i] === expected);
}

/**
 * Sniff an image's magic-byte signature and return the media type `docx`'s
 * `ImageRun` should be told to render it as, or `undefined` when the bytes don't
 * match any of the four supported signatures (including empty/truncated input).
 * Pure, total, and never throws for any `Uint8Array` — reads only the leading bytes,
 * never the body.
 */
export function sniffImageMediaType(bytes: Uint8Array): HeaderFooterImageMediaType | undefined {
  if (matchesSignature(bytes, PNG_SIGNATURE)) return 'image/png';
  if (matchesSignature(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (matchesSignature(bytes, GIF87A_SIGNATURE) || matchesSignature(bytes, GIF89A_SIGNATURE)) {
    return 'image/gif';
  }
  if (matchesSignature(bytes, BMP_SIGNATURE)) return 'image/bmp';
  return undefined;
}
