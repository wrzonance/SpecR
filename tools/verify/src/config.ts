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
  SPECR_API_BASE_URL: z.url(),
  // Required capture viewport width (px) for the harness's own page.
  // docx-preview geometry (window.__measure()) is getBoundingClientRect()-
  // based and therefore VIEWPORT-RELATIVE, not document-relative — at
  // narrow/unpinned viewports `x` can go negative. The driving agent
  // (Playwright) MUST resize to this width and scroll to top before any
  // screenshot; cropRegion()'s bounds-check throws VerifyRenderError as a
  // backstop, not the primary guard. See .env.example.
  VERIFY_VIEWPORT_WIDTH: z.coerce.number().int().positive().default(900),
});

export interface VerifyEnv {
  readonly specrApiBaseUrl: string;
  readonly viewportWidth: number;
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
  };
}
