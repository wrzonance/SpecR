// Environment configuration for the visual round-trip verification harness
// (#150). tools/verify is an isolated pnpm package (see pnpm-workspace.yaml)
// with its own .env.example — this does not read or extend src/lib/env.ts.

import * as z from 'zod';
import { VerifyValidationError } from './errors.js';

const envSchema = z.object({
  // Base URL of the running SpecR REST API this harness drives (POST /parse,
  // POST /templates/import, POST /specs/{id}/generate, ...). Same-renderer
  // comparison depends on going through the real API, never an in-process
  // shortcut — see issue #150 design decision 3.
  //
  // Must be an ORIGIN with no path/query/hash: the client builds request URLs
  // with `new URL('/parse', baseUrl)`, and an absolute path discards any path
  // prefix on the base (so `https://host/api/v2` would silently route to
  // `https://host/parse`). Reject that shape here rather than misroute quietly.
  SPECR_API_BASE_URL: z.url().refine((value) => {
    // Zod v4 still runs this refine when z.url() already failed, so guard the
    // parse and defer to z.url()'s own "invalid URL" error rather than throwing
    // a raw TypeError out of safeParse.
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return true;
    }
    return url.pathname === '/' && url.search === '' && url.hash === '';
  }, 'SPECR_API_BASE_URL must be an origin with no path, query, or fragment (e.g. http://localhost:3000)'),
  // Required capture viewport width (px) for the harness's own page.
  // docx-preview geometry (window.__measure()) is getBoundingClientRect()-
  // based and therefore VIEWPORT-RELATIVE, not document-relative — at
  // narrow/unpinned viewports `x` can go negative. The driving agent
  // (Playwright) MUST resize to this width and scroll to top before any
  // screenshot; cropRegion()'s bounds-check throws VerifyRenderError as a
  // backstop, not the primary guard. See .env.example.
  //
  // 3200 (not the WT-150 spike's original single-pane 900 guess) — the
  // shipped harness page (public/index.html) lays out reference/round-trip/
  // diff as 3 equal-width grid columns beside a 320px sidebar, and
  // docx-preview centers each rendered page (Letter=816px, A4=794px CSS px)
  // within its own pane. Below ~2768px viewport width the reference pane's
  // column is narrower than the page it must contain, so docx-preview
  // overflows it symmetrically and pageGeom.x goes negative even at a
  // "pinned" viewport — confirmed via Playwright during this build's task 8
  // manual smoke test. 3200 keeps ~70px of margin either side.
  VERIFY_VIEWPORT_WIDTH: z.coerce.number().int().positive().default(3200),
  // Port this harness's own Express server listens on (server/app.ts,
  // index.ts). Distinct from the main SpecR API's default PORT (3000, see
  // src/lib/env.ts) so both can run side by side on one machine.
  VERIFY_PORT: z.coerce.number().int().positive().default(4300),
});

export interface VerifyEnv {
  readonly specrApiBaseUrl: string;
  readonly viewportWidth: number;
  readonly port: number;
}

/**
 * Validate and load this harness's environment configuration, failing fast
 * with a serializable VerifyValidationError (stage: 'config') on anything
 * invalid or missing. Unlike src/lib/env.ts's module-level process.exit,
 * this is a plain function that throws — the caller (a CLI entrypoint, an
 * HTTP server bootstrap, or a test) decides how to surface the failure.
 */
export function loadVerifyEnv(env: NodeJS.ProcessEnv = process.env): VerifyEnv {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new VerifyValidationError('invalid tools/verify environment configuration', {
      stage: 'config',
      cause: result.error,
    });
  }
  return {
    specrApiBaseUrl: result.data.SPECR_API_BASE_URL,
    viewportWidth: result.data.VERIFY_VIEWPORT_WIDTH,
    port: result.data.VERIFY_PORT,
  };
}
