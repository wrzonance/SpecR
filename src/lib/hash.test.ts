import { describe, it, expect } from 'vitest';
import { sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('hashes a Buffer to the known SHA-256 hex digest', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf-8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('produces a 64-char lowercase hex string for empty input', () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
});
