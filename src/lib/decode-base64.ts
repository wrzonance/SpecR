// src/lib/decode-base64.ts
// Shared base64 → bytes decoder for MCP tools that accept file payloads inline
// (parse_document, import_template). Validates the encoding and enforces a decoded
// size cap from the *encoded* length before materializing the buffer, so an oversized
// payload is rejected without first allocating it.

/**
 * Canonical base64: zero or more 4-char groups, optionally closed by a 2-char+`==` or
 * 3-char+`=` group. Rejects whitespace, URL-safe variants, AND malformed padding like
 * `AAAA=` or `AAA==` — for those, Buffer.from() decodes more bytes than a length formula
 * predicts, which would let the size estimate under-count and slip an oversized payload
 * past the cap. Enforcing well-formed padding here keeps the decoded-size formula below
 * provably exact.
 */
export const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MAX_DECODED_BYTES = 10 * 1024 * 1024;

export type DecodedPayload = { readonly buffer: Buffer } | { readonly error: string };

/**
 * Validate a base64 payload string and decode it to bytes. Returns `{ buffer }` on
 * success or `{ error }` with a caller-safe message (bad encoding or over the cap).
 */
export function decodeBase64Payload(
  contentBase64: string,
  maxBytes: number = MAX_DECODED_BYTES
): DecodedPayload {
  if (!BASE64_RE.test(contentBase64)) {
    return { error: 'contentBase64 is not valid base64' };
  }
  // Exact decoded length: 3 bytes per 4 chars, minus one byte per '=' pad char. Using
  // the exact size (not ceil, which over-counts padding) so a payload decoding to
  // *exactly* maxBytes is accepted, matching the advertised cap — all without
  // materializing an oversized buffer first.
  let padding = 0;
  if (contentBase64.endsWith('==')) padding = 2;
  else if (contentBase64.endsWith('=')) padding = 1;
  const decodedBytes = Math.floor((contentBase64.length * 3) / 4) - padding;
  if (decodedBytes > maxBytes) {
    return { error: `Content exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB decoded limit` };
  }
  return { buffer: Buffer.from(contentBase64, 'base64') };
}
