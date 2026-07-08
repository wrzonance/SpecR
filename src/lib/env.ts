import * as z from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.string().default('info'),
  LOG_DIR: z.string().default('logs'),
  // When true, tee logs to a rotating JSONL file under LOG_DIR (pino-roll). Off by
  // default so tests/CI stay stdout-only; the corpus runner sets it true.
  LOG_TO_FILE: z.stringbool().default(false),
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
  // Strict offline OCR. When true, refuse to OCR unless eng.traineddata is
  // present locally (OCR_LANG_PATH dir or the cache) — pre-flighted BEFORE any
  // worker spawns, so an offline box never spawns a worker that would black-hole
  // on a CDN fetch and leak (ADR-039). Default false preserves the convenient
  // networked-dev behavior (CDN fetch on first run, bounded by OCR_INIT_TIMEOUT_MS).
  OCR_REQUIRE_LOCAL_TRAINEDDATA: z.stringbool().default(false),
  // Which MCP capability tiers this process exposes as callable tools.
  // Default omits `destructive` so an agent cannot delete projects/clients/libraries.
  // Authoritative parse lives in src/mcp/capabilities.ts (parseAllowedTiers); the tier
  // literals below are duplicated intentionally to keep src/lib free of an src/mcp import.
  MCP_ALLOWED_TIERS: z
    .string()
    .default('read,write')
    .refine((v) => v.split(',').every((t) => ['read', 'write', 'destructive'].includes(t.trim())), {
      message: 'MCP_ALLOWED_TIERS must be a comma-separated list of: read, write, destructive',
    }),
  // Rate limiting (express-rate-limit). These are the STARTUP SEED: the limiters read
  // DISABLE_RATE_LIMIT and the *_MAX values LIVE on every request (skip/limit closures),
  // so a future admin surface can mutate `config.*` at runtime and have it take effect on
  // the next request without a restart — config is intentionally NOT frozen. Only
  // RATE_LIMIT_WINDOW_MS is fixed when a limiter is constructed (the library bakes the
  // window in). Secure by default: limiting is ON; the web-UI demo opts out via its .env.
  DISABLE_RATE_LIMIT: z.stringbool().default(false),
  RATE_LIMIT_UPLOAD_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_MCP_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  process.stderr.write('Invalid environment variables:\n');
  process.stderr.write(JSON.stringify(result.error.issues, null, 2) + '\n');
  process.exit(1);
}

export const config = result.data;
export type Config = typeof result.data;
