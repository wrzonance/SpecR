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
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  HEADER_FOOTER_BODY_ENVELOPE_BYTES,
  HEADER_FOOTER_JSON_BODY_LIMIT_BYTES,
} from '../lib/header-footer-body-limit.js';

/**
 * Re-exported (not redefined) from `src/lib/header-footer-body-limit.ts` —
 * that module is the single derivation site, shared with the AST schema's
 * own size invariant (`src/ast/header-footer-schemas.ts`). Kept as named
 * exports here so existing importers of this file are unaffected.
 */
export { HEADER_FOOTER_BODY_ENVELOPE_BYTES, HEADER_FOOTER_JSON_BODY_LIMIT_BYTES };

// Express 5 defaults both `case sensitive routing` and `strict routing` to
// disabled, so `router.put('/libraries/:id/header-footer', ...)` matches a
// request path regardless of case and with or without a trailing slash —
// `req.path` reaching this predicate can carry either. The `i` flag and the
// trailing `\/?` mirror that exactly so this predicate never disagrees with
// how Express actually dispatched the request.
const HEADER_FOOTER_COMPOSITION_PATH =
  /^\/(?:libraries|projects|packages|revisions)\/[^/]+\/header-footer\/?$/i;

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

// The MCP endpoint (`/mcp`) or a subpath (`/mcp/…`). Segment-bounded so a
// lookalike REST path like `/mcp-anything` does NOT match and keeps the default
// limit. The `i` flag mirrors Express's disabled case-sensitive routing (see
// HEADER_FOOTER_COMPOSITION_PATH), so `/MCP` — which Express still dispatches to
// the MCP handler — is matched too.
const MCP_PATH = /^\/mcp(?:\/|$)/i;

/**
 * True for the MCP endpoint and its subpaths only. The MCP handler applies its
 * own route-local body limit (`src/mcp/server.ts`), so those requests bypass
 * the REST default here; every other path — including lookalikes such as
 * `/mcp-anything` — keeps `express.json()`'s default. Pure and total.
 */
export function isMcpPath(path: string): boolean {
  return MCP_PATH.test(path);
}

/**
 * Builds the REST body-size dispatch middleware `src/index.ts` wires
 * directly in front of `router` — exported (rather than left as an inline
 * closure in `src/index.ts`) so both production and integration tests use
 * the exact same wiring instead of the test hand-copying it (#490). `/mcp`
 * is skipped entirely (it applies its own route-local limit in
 * `src/mcp/server.ts`); every header/footer composition PUT gets the
 * derived, image-sized limit; every other REST route keeps
 * `express.json()`'s untouched default.
 */
export function createHeaderFooterBodyLimitMiddleware(): RequestHandler {
  const restJson = express.json();
  const headerFooterCompositionJson = express.json({ limit: HEADER_FOOTER_JSON_BODY_LIMIT_BYTES });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isMcpPath(req.path)) {
      next();
      return;
    }
    if (isHeaderFooterCompositionWrite(req)) {
      headerFooterCompositionJson(req, res, next);
      return;
    }
    restJson(req, res, next);
  };
}
