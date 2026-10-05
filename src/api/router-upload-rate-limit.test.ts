import { describe, expect, it } from 'vitest';
import { router, parseRateLimit } from './router.js';

// ─── Invariant: every file-upload route sits behind the upload rate limiter ──
//
// #692 — POST /specs/:id/diff accepted a multipart upload (and parsed the
// DOCX) with no limiter in front of it, while the other four upload routes
// had one. Nothing linked "takes an upload" to "is rate limited", so a new
// upload route could repeat the omission silently. This walks the real router
// and requires the limiter to precede multer on every route that mounts it.
//
// A structural walk (not a request loop) because the limiter deliberately
// skips when NODE_ENV === 'test', so it can never answer 429 in this suite.

// multer names the middleware `upload.single()` returns; the vacuity guard
// below turns a rename into a loud failure instead of an empty sweep.
const MULTER_MIDDLEWARE_NAME = 'multerMiddleware';

interface UploadRoute {
  readonly label: string;
  readonly limiterIndex: number;
  readonly uploadIndex: number;
}

function uploadRoutes(): UploadRoute[] {
  return router.stack.flatMap((layer) => {
    const route = layer.route;
    if (route === undefined) return [];
    const handles = route.stack.map((routeLayer) => routeLayer.handle);
    const uploadIndex = handles.findIndex((handle) => handle.name === MULTER_MIDDLEWARE_NAME);
    if (uploadIndex === -1) return [];
    const method = route.stack[0]?.method ?? 'unknown';
    return [
      {
        label: `${method.toUpperCase()} ${route.path}`,
        limiterIndex: handles.indexOf(parseRateLimit),
        uploadIndex,
      },
    ];
  });
}

describe('upload routes are rate limited (#692)', () => {
  it('finds the upload routes at all (guards against a vacuous sweep)', () => {
    expect(
      uploadRoutes().map((route) => route.label),
      'no route mounting multer was found — the walk broke (multer renamed its middleware, or ' +
        'the router nests differently), so the invariant below would pass vacuously'
    ).toContain('POST /specs/:id/diff');
  });

  it('upload: POST /specs/:id/diff and every other upload route run the limiter before multer', () => {
    const unlimited = uploadRoutes()
      .filter((route) => route.limiterIndex === -1 || route.limiterIndex > route.uploadIndex)
      .map((route) => route.label);

    expect(
      unlimited,
      'these routes buffer and parse an uploaded file without parseRateLimit ahead of multer'
    ).toEqual([]);
  });
});
