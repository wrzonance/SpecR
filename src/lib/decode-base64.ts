// src/lib/decode-base64.ts
// Shared base64 → bytes decoder for MCP tools that accept file payloads inline
// (parse_document, import_template). Validates the encoding and enforces a decoded
// size cap from the *encoded* length before materializing the buffer, so an oversized
// payload is rejected without first allocating it.

/** Base64 alphabet with optional `=` padding — rejects whitespace/URL-safe variants. */
export const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

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
  const estimatedBytes = Math.ceil((contentBase64.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    return { error: `Content exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB decoded limit` };
  }
  return { buffer: Buffer.from(contentBase64, 'base64') };
}
