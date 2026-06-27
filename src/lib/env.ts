import * as z from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.string().default('info'),
  OCR_MIN_CHARS_PER_PAGE: z.coerce.number().int().positive().default(16),
  OCR_LOW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(100).default(70),
  OCR_LANG_PATH: z.string().min(1).optional(),
  OCR_CACHE_PATH: z.string().min(1).optional(),
  // Render scale multiplies page raster dimensions for OCR; cap it so a bad env
  // value cannot explode image size and OOM the worker (scale 10 ≈ 720 DPI on a
  // Letter page is already far beyond what OCR needs).
  OCR_RENDER_SCALE: z.coerce.number().positive().max(10).default(2),
  // Bound OCR worker initialization. When traineddata is uncached AND
  // OCR_LANG_PATH is unset, tesseract.js fetches eng.traineddata from a CDN; a
  // network that accepts the connection but never responds would otherwise hang
  // the parse job forever. On timeout we degrade to a `pdf-ocr-unusable` warning.
  OCR_INIT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  process.stderr.write('Invalid environment variables:\n');
  process.stderr.write(JSON.stringify(result.error.issues, null, 2) + '\n');
  process.exit(1);
}

export const config = result.data;
export type Config = typeof result.data;
