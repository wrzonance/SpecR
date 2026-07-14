// src/lib/decode-base64.ts
// Shared base64 → bytes decoder for MCP tools that accept file payloads inline
// (parse_document, import_template). Validates the encoding and enforces a decoded
// size cap from the *encoded* length before materializing the buffer, so an oversized
// payload is rejected without first allocating it.

/**
 * Canonical base64 alphabet, checked in `isValidBase64Payload` below. A single
 * quantified character class (`[...]*`) rather than a repeated *group*
 * (`(?:[...]{4})*`) — see that function's doc for why the distinction matters.
 */
const BASE64_ALPHABET_RE = /^[A-Za-z0-9+/]*$/;

/** Valid base64 padding is at most 2 trailing `=` characters. */
const MAX_PADDING_LENGTH = 2;

const MAX_DECODED_BYTES = 10 * 1024 * 1024;

/**
 * Count of trailing `=` characters in `input`, capped at `MAX_PADDING_LENGTH + 1`
 * (the caller only needs "how many, up to and including one-past-valid" — never
 * the true count for a pathological all-`=` input). A manual bounded scan, not a
 * `/=*$/` regex: an unbounded quantifier anchored at the end is exactly the shape
 * static analysis (and, for the *grouped* variant this module used to use, V8's
 * own backtracking engine — see `isValidBase64Payload`) flags as a potential
 * super-linear scan on adversarial input. Bounding the loop keeps this O(1)
 * regardless of `input`'s length.
 */
function trailingPaddingLength(input: string): number {
  let count = 0;
  while (count <= MAX_PADDING_LENGTH && input[input.length - 1 - count] === '=') {
    count++;
  }
  return count;
}

export type DecodedPayload = { readonly buffer: Buffer } | { readonly error: string };

/**
 * True for canonical base64: zero or more 4-char groups, optionally closed by a
 * 2-char+`==` or 3-char+`=` group. Rejects whitespace, URL-safe variants, AND
 * malformed padding like `AAAA=` or `AAA==` — for those, Buffer.from() decodes
 * more bytes than a length formula predicts, which would let the size estimate
 * under-count and slip an oversized payload past the cap.
 *
 * Deliberately NOT a single regex with a grouped, quantified subpattern
 * (`(?:[A-Za-z0-9+/]{4})*`) — V8's backtracking regex engine recurses once per
 * matched *group* (unlike a plain `X*` character-class repeat, which compiles
 * to a flat loop), so that pattern threw `RangeError: Maximum call stack size
 * exceeded` on multi-megabyte payloads — well within this function's own
 * 10 MB default cap, and well within the 5 MB header/footer image cap
 * (#308 regression). Splitting the check into ungrouped passes keeps every
 * pass on V8's linear fast path regardless of input size.
 */
function isValidBase64Payload(input: string): boolean {
  if (input.length % 4 !== 0) return false;
  const paddingLength = trailingPaddingLength(input);
  if (paddingLength > MAX_PADDING_LENGTH) return false;
  const body = input.slice(0, input.length - paddingLength);
  return BASE64_ALPHABET_RE.test(body);
}

/**
 * Validate a base64 payload string and decode it to bytes. Returns `{ buffer }` on
 * success or `{ error }` with a caller-safe message (bad encoding or over the cap).
 */
export function decodeBase64Payload(
  contentBase64: string,
  maxBytes: number = MAX_DECODED_BYTES
): DecodedPayload {
  if (!isValidBase64Payload(contentBase64)) {
    return { error: 'contentBase64 is not valid base64' };
  }
  // Exact decoded length: 3 bytes per 4 chars, minus one byte per '=' pad char. Using
  // the exact size (not ceil, which over-counts padding) so a payload decoding to
  // *exactly* maxBytes is accepted, matching the advertised cap — all without
  // materializing an oversized buffer first. `contentBase64` already passed
  // `isValidBase64Payload`, so its padding is provably 0, 1, or 2 here.
  const padding = trailingPaddingLength(contentBase64);
  const decodedBytes = Math.floor((contentBase64.length * 3) / 4) - padding;
  if (decodedBytes > maxBytes) {
    return { error: `Content exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB decoded limit` };
  }
  return { buffer: Buffer.from(contentBase64, 'base64') };
}
