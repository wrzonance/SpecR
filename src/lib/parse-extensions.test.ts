import { describe, it, expect } from 'vitest';
import { ALLOWED_PARSE_EXTENSIONS } from './parse-extensions.js';

// #567 finding 6: src/api/parse.ts and src/mcp/parse-document-handler.ts each
// used to hand-write their own extension allowlist, and the two silently
// drifted (the MCP copy was missing .pdf). Pinning the constant's exact
// membership here, with both call sites importing it (see src/api/parse.ts's
// `ALLOWED_EXT = ALLOWED_PARSE_EXTENSIONS` and the MCP handler's
// `ALLOWED_PARSE_EXTENSIONS.has(ext)` gate), is what keeps this a single
// source of truth going forward instead of two lists that happen to agree today.
describe('ALLOWED_PARSE_EXTENSIONS', () => {
  it('is the one allowlist of parse-document extensions: .docx, .pdf, .sec, .txt', () => {
    expect([...ALLOWED_PARSE_EXTENSIONS].sort((a, b) => a.localeCompare(b))).toEqual([
      '.docx',
      '.pdf',
      '.sec',
      '.txt',
    ]);
  });
});
