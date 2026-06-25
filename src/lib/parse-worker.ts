import { z } from 'zod';
import { parse } from '../parser/index.js';
import { ParseWarningSchema, SecRefSchema } from '../ast/index.js';
import type { SpecTree, SecRef } from '../ast/index.js';
import { SectionNumberSchema } from './section-number.js';
import { config } from './env.js';

export interface WorkerInput {
  readonly buffer: Buffer;
  readonly ext: string;
}

export interface WorkerOutput {
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
  readonly capabilities?: readonly string[];
}

// Single source of truth for the structured-clone result coming back over the
// Piscina thread boundary. Both upload handlers (parse, onboarding) parse the
// raw worker output with this schema before use — the worker runs in another
// thread, so its return is untrusted boundary input (CLAUDE.md: validate with
// Zod, chain the ZodError as cause). `as WorkerOutput` only narrows the validated
// value back to the readonly interface; it is never a bare cast of `unknown`.
export const workerOutputSchema = z.object({
  tree: z.object({
    id: z.string(),
    section: z.union([SectionNumberSchema, z.literal('unknown')]),
    title: z.string(),
    parts: z.array(z.unknown()),
    warnings: z.array(ParseWarningSchema).optional(),
  }),
  refs: z.array(SecRefSchema).default([]),
  capabilities: z.array(z.string()).optional(),
});

function parseOptionsFromConfig() {
  return {
    ocrMinCharsPerPage: config.OCR_MIN_CHARS_PER_PAGE,
    ocrLowConfidenceThreshold: config.OCR_LOW_CONFIDENCE_THRESHOLD,
    ocrRenderScale: config.OCR_RENDER_SCALE,
    ...(config.OCR_LANG_PATH !== undefined ? { ocrLangPath: config.OCR_LANG_PATH } : {}),
    ...(config.OCR_CACHE_PATH !== undefined ? { ocrCachePath: config.OCR_CACHE_PATH } : {}),
  };
}

// Delegates to the parse() orchestrator so the upload path runs the same
// pipeline as CLI ingest — including lib/infer-section section/title recovery,
// which this worker previously skipped (DOCX uploads whose docProps/core.xml
// carries no metadata persisted section='unknown').
// Format safety validation (assertSecSafe/assertDocxSafe) already ran in the
// main thread before the job was created.
export default async function parseWorker({ buffer, ext }: WorkerInput): Promise<WorkerOutput> {
  const { tree, refs, capabilities } = await parse(
    buffer,
    `upload${ext}`,
    parseOptionsFromConfig()
  );
  return { tree, refs, ...(capabilities !== undefined ? { capabilities } : {}) };
}
