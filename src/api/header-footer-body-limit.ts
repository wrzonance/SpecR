// src/api/header-footer-body-limit.ts
//
// #490 — src/index.ts dispatches every non-`/mcp` REST request through a single
// `express.json()` instance capped at the library default (100kb). The
// header/footer composition PUT routes can legitimately embed a base64-encoded
// image up to `MAX_IMAGE_BASE64_LENGTH` (src/lib/image-media-type.ts) per cell,
// so a correctly-sized write is rejected by body-parser before Zod ever sees
// it. This module derives a route-scoped limit sized for exactly that case and
// the predicate `src/index.ts` uses to route requests to it instead of the
// default.
//
// Scoped to PUT only: GET and DELETE never carry a request body, so widening
// their limit has no benefit and would needlessly widen the request-body DoS
// surface those routes are otherwise protected from by the small default.
import type { Request } from 'express';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';

/**
 * Headroom above one max-sized image for the surrounding JSON structure — the
 * composition envelope, other header/footer cells, and their non-image text
 * runs. Deliberately generous: a composition with several near-max-sized
 * images can still exceed this derived limit despite each field individually
 * passing the AST schema's own per-field bound — an accepted limitation, not
 * a bug, since the byte budget here covers exactly the one-image case the
 * issue describes.
 */
export const HEADER_FOOTER_BODY_ENVELOPE_BYTES = 262_144; // 256 KiB

/**
 * Route-scoped JSON body-size limit for header/footer composition writes,
 * derived from (never hardcoded independently of) `MAX_IMAGE_BASE64_LENGTH`
 * so it can never silently fall out of sync with the image cap it exists to
 * accommodate.
 */
export const HEADER_FOOTER_JSON_BODY_LIMIT_BYTES =
  MAX_IMAGE_BASE64_LENGTH + HEADER_FOOTER_BODY_ENVELOPE_BYTES;

const HEADER_FOOTER_COMPOSITION_PATH =
  /^\/(?:libraries|projects|packages|revisions)\/[^/]+\/header-footer$/;

/**
 * True only for the four `PUT .../header-footer` composition-write routes —
 * the sole REST endpoints whose request body can legitimately approach
 * `HEADER_FOOTER_JSON_BODY_LIMIT_BYTES`. False for their GET/DELETE siblings
 * (no body), the read-only `/header-footer/resolved` views, `/mcp` (its own
 * route-local limit applies), and every unrelated route. Pure and total —
 * never throws.
 */
export function isHeaderFooterCompositionWrite(req: Pick<Request, 'method' | 'path'>): boolean {
  return req.method === 'PUT' && HEADER_FOOTER_COMPOSITION_PATH.test(req.path);
}
