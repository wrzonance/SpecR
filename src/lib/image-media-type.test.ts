import { describe, it, expect } from 'vitest';
import {
  sniffImageMediaType,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BASE64_LENGTH,
} from './image-media-type.js';

// Real magic-byte prefixes for each format sniffImageMediaType supports. These are
// deliberately minimal — just the signature bytes, no real pixel data — because
// sniffImageMediaType only ever reads the header, never the body.
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87A_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00]);
const GIF89A_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);
const BMP_BYTES = Uint8Array.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00]);

describe('sniffImageMediaType', () => {
  it('sniffs a PNG signature', () => {
    expect(sniffImageMediaType(PNG_BYTES)).toBe('image/png');
  });

  it('sniffs a JPEG signature', () => {
    expect(sniffImageMediaType(JPEG_BYTES)).toBe('image/jpeg');
  });

  it('sniffs both GIF87a and GIF89a signatures', () => {
    expect(sniffImageMediaType(GIF87A_BYTES)).toBe('image/gif');
    expect(sniffImageMediaType(GIF89A_BYTES)).toBe('image/gif');
  });

  it('sniffs a BMP signature', () => {
    expect(sniffImageMediaType(BMP_BYTES)).toBe('image/bmp');
  });

  it('returns undefined for an empty buffer', () => {
    expect(sniffImageMediaType(Uint8Array.from([]))).toBeUndefined();
  });

  it('returns undefined for a buffer truncated mid-signature', () => {
    // First 3 bytes of the 8-byte PNG signature — a real short-read scenario.
    expect(sniffImageMediaType(PNG_BYTES.subarray(0, 3))).toBeUndefined();
    expect(sniffImageMediaType(JPEG_BYTES.subarray(0, 2))).toBeUndefined();
    expect(sniffImageMediaType(BMP_BYTES.subarray(0, 1))).toBeUndefined();
  });

  it('returns undefined for an SVG (unsupported vector format)', () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="..."></svg>');
    expect(sniffImageMediaType(svg)).toBeUndefined();
  });

  it('returns undefined for a WEBP (RIFF container, unsupported by docx ImageRun)', () => {
    // "RIFF????WEBP" — a real WEBP starts with a RIFF header, not one of the four
    // signatures this module recognizes.
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(sniffImageMediaType(webp)).toBeUndefined();
  });

  it('returns undefined for arbitrary unrecognized bytes', () => {
    expect(sniffImageMediaType(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toBeUndefined();
  });

  it('never throws, for any input including large/random buffers', () => {
    const cases: readonly Uint8Array[] = [
      Uint8Array.from([]),
      Uint8Array.from([0xff]),
      new Uint8Array(1),
      new Uint8Array(4096).fill(0x42), // large, all "BM"-prefixed garbage
      crypto.getRandomValues(new Uint8Array(64)),
    ];
    for (const bytes of cases) {
      expect(() => sniffImageMediaType(bytes)).not.toThrow();
    }
  });

  it('is pure — identical input yields identical output across repeated calls', () => {
    const first = sniffImageMediaType(JPEG_BYTES);
    const second = sniffImageMediaType(JPEG_BYTES);
    expect(first).toBe(second);
    // Calling it does not mutate the input it was given.
    expect(JPEG_BYTES).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  });
});

describe('MAX_IMAGE_BYTES / MAX_IMAGE_BASE64_LENGTH', () => {
  it('are positive integers', () => {
    expect(Number.isInteger(MAX_IMAGE_BYTES)).toBe(true);
    expect(MAX_IMAGE_BYTES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_IMAGE_BASE64_LENGTH)).toBe(true);
    expect(MAX_IMAGE_BASE64_LENGTH).toBeGreaterThan(0);
  });

  it('MAX_IMAGE_BASE64_LENGTH is large enough to encode MAX_IMAGE_BYTES worth of data', () => {
    // Base64 inflates by 4/3 (rounded up to a 4-char group) — a real base64 string
    // decoding to exactly MAX_IMAGE_BYTES must fit within the cap.
    const exactEncodedLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
    expect(MAX_IMAGE_BASE64_LENGTH).toBeGreaterThanOrEqual(exactEncodedLength);
  });
});
