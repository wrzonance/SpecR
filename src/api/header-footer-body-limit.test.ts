// src/api/header-footer-body-limit.test.ts
//
// #490 — the header/footer composition PUT routes accept `HeaderFooterComposition`
// payloads that can legitimately embed a base64-encoded image up to
// `MAX_IMAGE_BASE64_LENGTH` (src/lib/image-media-type.ts) *per cell*, but
// src/index.ts's default `express.json()` dispatch caps every REST body at the
// library default (100kb) — so a legitimately-sized header/footer image write
// is rejected before Zod ever sees it. This pins the derived, route-scoped
// limit and the predicate that decides which requests get it.
import { describe, it, expect } from 'vitest';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
import {
  HEADER_FOOTER_BODY_ENVELOPE_BYTES,
  HEADER_FOOTER_JSON_BODY_LIMIT_BYTES,
  isHeaderFooterCompositionWrite,
  isMcpPath,
} from './header-footer-body-limit.js';

describe('HEADER_FOOTER_JSON_BODY_LIMIT_BYTES (#490)', () => {
  it('is derived from MAX_IMAGE_BASE64_LENGTH, not a bare hardcoded literal', () => {
    // INV1: strictly greater than the largest single image field alone — the
    // envelope (surrounding JSON structure + other header/footer cells) needs
    // room on top of one max-sized image, so the limit can never merely equal
    // MAX_IMAGE_BASE64_LENGTH.
    expect(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_IMAGE_BASE64_LENGTH);
  });

  it('equals MAX_IMAGE_BASE64_LENGTH + HEADER_FOOTER_BODY_ENVELOPE_BYTES exactly', () => {
    // INV2: pins the algebraic *derivation* itself, not just an inequality —
    // a regression that swaps the sum for a bare hardcoded literal equal to
    // today's value would still satisfy INV1 above, but fails this the
    // moment either input constant moves and the hardcoded value doesn't
    // move with it.
    expect(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES).toBe(
      MAX_IMAGE_BASE64_LENGTH + HEADER_FOOTER_BODY_ENVELOPE_BYTES
    );
  });
});

describe('isHeaderFooterCompositionWrite (#490)', () => {
  const putPaths = [
    '/libraries/11111111-1111-1111-1111-111111111111/header-footer',
    '/projects/11111111-1111-1111-1111-111111111111/header-footer',
    '/packages/11111111-1111-1111-1111-111111111111/header-footer',
    '/revisions/11111111-1111-1111-1111-111111111111/header-footer',
  ];

  it.each(putPaths)('true for PUT %s (the composition write route)', (path) => {
    expect(isHeaderFooterCompositionWrite({ method: 'PUT', path })).toBe(true);
  });

  it.each(putPaths)('false for GET %s (no body to size-limit)', (path) => {
    expect(isHeaderFooterCompositionWrite({ method: 'GET', path })).toBe(false);
  });

  it.each(putPaths)('false for DELETE %s (no body to size-limit)', (path) => {
    expect(isHeaderFooterCompositionWrite({ method: 'DELETE', path })).toBe(false);
  });

  const resolvedGetPaths = [
    '/projects/11111111-1111-1111-1111-111111111111/header-footer/resolved',
    '/packages/11111111-1111-1111-1111-111111111111/header-footer/resolved',
    '/revisions/11111111-1111-1111-1111-111111111111/header-footer/resolved',
  ];

  it.each(resolvedGetPaths)(
    'false for %s (read-only resolved view, never a composition write)',
    (path) => {
      expect(isHeaderFooterCompositionWrite({ method: 'PUT', path })).toBe(false);
    }
  );

  it('false for /mcp (its own route-local limit applies instead)', () => {
    expect(isHeaderFooterCompositionWrite({ method: 'PUT', path: '/mcp' })).toBe(false);
  });

  it('false for an unrelated PUT route', () => {
    expect(
      isHeaderFooterCompositionWrite({
        method: 'PUT',
        path: '/libraries/11111111-1111-1111-1111-111111111111/keynotes',
      })
    ).toBe(false);
  });

  // Express 5 (`app.set('case sensitive routing')` / `'strict routing'`
  // both default to disabled) routes case-insensitively and treats a
  // trailing slash as optional, so `req.path` reaching this predicate can
  // legitimately differ in case or trailing slash from the route pattern
  // while Express still dispatches it to the composition handler. The
  // predicate must classify every one of those the same as the canonical
  // form, or a real composition write silently falls through to the small
  // default body-parser limit instead of the derived one.
  it('true for a mixed-case path (Express 5 default: case-insensitive routing)', () => {
    expect(
      isHeaderFooterCompositionWrite({
        method: 'PUT',
        path: '/Libraries/11111111-1111-1111-1111-111111111111/Header-Footer',
      })
    ).toBe(true);
  });

  it('true for a path with a trailing slash (Express 5 default: non-strict routing)', () => {
    expect(
      isHeaderFooterCompositionWrite({
        method: 'PUT',
        path: '/libraries/11111111-1111-1111-1111-111111111111/header-footer/',
      })
    ).toBe(true);
  });

  it('still false for a resolved-view path even with mixed case', () => {
    expect(
      isHeaderFooterCompositionWrite({
        method: 'PUT',
        path: '/Projects/11111111-1111-1111-1111-111111111111/Header-Footer/Resolved',
      })
    ).toBe(false);
  });
});

describe('isMcpPath (#490 — the /mcp bypass predicate)', () => {
  it.each(['/mcp', '/mcp/', '/mcp/messages', '/MCP', '/Mcp'])(
    'true for %s (the MCP endpoint or a subpath, case-insensitive)',
    (path) => {
      expect(isMcpPath(path)).toBe(true);
    }
  );

  // Regression (CodeRabbit): a bare startsWith('/mcp') also matched lookalike
  // REST paths and silently widened their body-size budget. The segment
  // boundary must keep every non-MCP route on the default limit.
  it.each(['/mcp-anything', '/mcpx', '/mcp_config', '/libraries/x/header-footer', '/'])(
    'false for %s (lookalike or unrelated route keeps the default limit)',
    (path) => {
      expect(isMcpPath(path)).toBe(false);
    }
  );
});
