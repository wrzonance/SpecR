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
  HEADER_FOOTER_JSON_BODY_LIMIT_BYTES,
  isHeaderFooterCompositionWrite,
} from './header-footer-body-limit.js';

describe('HEADER_FOOTER_JSON_BODY_LIMIT_BYTES (#490)', () => {
  it('is derived from MAX_IMAGE_BASE64_LENGTH, not a bare hardcoded literal', () => {
    // INV1: strictly greater than the largest single image field alone — the
    // envelope (surrounding JSON structure + other header/footer cells) needs
    // room on top of one max-sized image, so the limit can never merely equal
    // MAX_IMAGE_BASE64_LENGTH.
    expect(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_IMAGE_BASE64_LENGTH);
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
});
