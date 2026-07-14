import { describe, it, expect } from 'vitest';
import { decodeBase64Payload } from './decode-base64.js';

describe('decodeBase64Payload', () => {
  it('decodes a valid base64 payload to its bytes', () => {
    const res = decodeBase64Payload(Buffer.from('hello').toString('base64'));
    expect('buffer' in res).toBe(true);
    if ('buffer' in res) expect(res.buffer.toString()).toBe('hello');
  });

  it('rejects a non-base64 payload', () => {
    expect('error' in decodeBase64Payload('not base64!!')).toBe(true);
  });

  // Regression: malformed padding passes the old loose regex but Buffer.from decodes
  // more bytes than the length formula predicts, under-counting the cap. Now rejected.
  it('rejects malformed base64 padding', () => {
    for (const bad of ['AAAA=', 'AAA==', 'A=', 'AB=', 'AAAAA=']) {
      expect('error' in decodeBase64Payload(bad)).toBe(true);
    }
  });

  // Regression: the padded-length estimate must not over-count. A payload decoding to
  // *exactly* maxBytes is at the cap, not over it — the old ceil() rejected these.
  it('accepts payloads decoding to exactly maxBytes, including padded ones', () => {
    const oneByte = Buffer.from([1]).toString('base64'); // "AQ==" — 2 pad chars, 1 byte
    const twoBytes = Buffer.from([1, 2]).toString('base64'); // 1 pad char, 2 bytes
    const threeBytes = Buffer.from([1, 2, 3]).toString('base64'); // 0 pad, 3 bytes
    expect('buffer' in decodeBase64Payload(oneByte, 1)).toBe(true);
    expect('buffer' in decodeBase64Payload(twoBytes, 2)).toBe(true);
    expect('buffer' in decodeBase64Payload(threeBytes, 3)).toBe(true);
  });

  it('rejects a payload one byte over maxBytes', () => {
    const fourBytes = Buffer.from([1, 2, 3, 4]).toString('base64');
    expect('error' in decodeBase64Payload(fourBytes, 3)).toBe(true);
  });

  // Regression (#308): BASE64_RE's grouped, quantified subpattern
  // (`(?:X{4})*`) forces V8's backtracking regex engine to recurse once per
  // matched 4-char group. On a multi-megabyte payload — well within
  // decodeBase64Payload's own default 10 MB cap, and well within the 5 MB
  // header/footer image cap that Zod already accepted — that recursion blew
  // the JS call stack (`RangeError: Maximum call stack size exceeded`)
  // before validation ever completed, for fully valid input.
  it('does not throw a stack overflow for a large, realistically-sized valid payload', () => {
    const fourMegabytes = Buffer.alloc(4 * 1024 * 1024, 0x41).toString('base64');
    expect(() => decodeBase64Payload(fourMegabytes)).not.toThrow();
    const result = decodeBase64Payload(fourMegabytes);
    expect('buffer' in result).toBe(true);
  });

  it('does not throw a stack overflow at the decoded-size cap boundary', () => {
    const tenMegabytes = Buffer.alloc(10 * 1024 * 1024, 0x41).toString('base64');
    expect(() => decodeBase64Payload(tenMegabytes)).not.toThrow();
    const result = decodeBase64Payload(tenMegabytes);
    expect('buffer' in result).toBe(true);
  });
});
