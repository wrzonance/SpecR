// Error hierarchy for the visual round-trip verification harness (#150).
//
// Deliberately standalone: tools/verify is an isolated pnpm package (see
// pnpm-workspace.yaml) and does not import src/lib/errors.ts's SpecrError —
// the harness has zero runtime dependency on the main API package.
//
// Every pipeline stage (config/upload/parse/import/generate/render/measure/
// screenshot/diff/report) funnels its catch block through toRunError()
// before the failure crosses a serialization boundary — run/pipeline.ts's
// failRun() persists the result on the RunRecord (polled via GET
// /api/runs/:runId), and index.ts's boot-time catch prints it — so a
// pipeline-stage failure always carries { stage, message, cause } — never a
// bare string, and never a raw Error with a stack trace that could leak
// internals across that boundary.
//
// The raw HTTP transport boundary (server/app.ts's Express error-handling
// middleware) is a SEPARATE, lighter-weight boundary and deliberately does
// NOT go through toRunError(): a malformed request body or an unwrapped fs
// exception escaping a handler isn't a pipeline stage, so there is no
// RunStage to attach. That middleware instead mirrors
// src/api/middleware/error.ts's own shape directly (MulterError -> 400 with
// its message, otherwise `err.status ?? 500` with a fixed, non-leaking
// message) — see app.test.ts's "errorHandler" suite for the pinned contract.

export const RUN_STAGES = [
  'config',
  'upload',
  'parse',
  'import',
  'generate',
  'render',
  'measure',
  'screenshot',
  'diff',
  'report',
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

export interface VerifyErrorOptions extends ErrorOptions {
  readonly stage: RunStage;
}

/** Base class for every error this harness raises. */
export class VerifyError extends Error {
  readonly stage: RunStage;

  constructor(message: string, options: VerifyErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.stage = options.stage;
  }
}

/** The SpecR REST API rejected a request, or returned an unexpected shape. */
export class VerifyApiError extends VerifyError {}

/** Rendering failed: harness page load, measurement, screenshot capture, or region crop. */
export class VerifyRenderError extends VerifyError {}

/** A Zod (or other boundary) validation failed: config, HTTP request, or API response shape. */
export class VerifyValidationError extends VerifyError {}

/**
 * Serializable shape of a failure, safe to persist in a RunRecord or send as
 * an HTTP response body. Never carries a stack trace.
 */
export interface RunError {
  readonly stage: RunStage;
  readonly message: string;
  readonly cause?: string;
}

function describeCause(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (typeof cause === 'number' || typeof cause === 'boolean') return String(cause);
  try {
    return JSON.stringify(cause);
  } catch {
    return 'unserializable cause';
  }
}

/**
 * Convert any thrown value into a serializable RunError.
 *
 * A VerifyError already carries its own stage (set at the point it was
 * thrown, deep in the pipeline) — that origin stage wins over the `stage`
 * argument, which is only a fallback for a plain Error or non-Error value
 * that escaped without being wrapped.
 */
export function toRunError(stage: RunStage, error: unknown): RunError {
  const resolvedStage = error instanceof VerifyError ? error.stage : stage;
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? describeCause(error.cause) : undefined;
  return cause === undefined
    ? { stage: resolvedStage, message }
    : { stage: resolvedStage, message, cause };
}
