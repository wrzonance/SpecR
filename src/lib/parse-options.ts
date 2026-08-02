// src/lib/parse-options.ts
// Single source of truth for the env-derived `ParseOptions` every ingest path
// must hand to parser/index.ts's `parse()`.
//
// Extracted from parse-worker.ts (#567 review finding): the MCP
// parse_document tool now calls `parse()` directly — the same orchestrator the
// REST upload worker runs — and originally passed only a numbering profile.
// That silently dropped the OCR policy for the .pdf support this change
// introduced: with OCR_REQUIRE_LOCAL_TRAINEDDATA=true a scanned PDF submitted
// over MCP would still spawn Tesseract and fetch trained data over the
// network, and the configured thresholds, cache path, render scale and init
// timeout were all ignored. Both callers now derive their options here, so an
// OCR setting can never apply to one ingest path and not the other.
import { config } from './env.js';
import type { ParseOptions } from '../parser/index.js';

export function parseOptionsFromConfig(): ParseOptions {
  return {
    ocrMinCharsPerPage: config.OCR_MIN_CHARS_PER_PAGE,
    ocrLowConfidenceThreshold: config.OCR_LOW_CONFIDENCE_THRESHOLD,
    ocrRenderScale: config.OCR_RENDER_SCALE,
    ocrInitTimeoutMs: config.OCR_INIT_TIMEOUT_MS,
    ocrRequireLocalTraineddata: config.OCR_REQUIRE_LOCAL_TRAINEDDATA,
    ...(config.OCR_LANG_PATH !== undefined ? { ocrLangPath: config.OCR_LANG_PATH } : {}),
    ...(config.OCR_CACHE_PATH !== undefined ? { ocrCachePath: config.OCR_CACHE_PATH } : {}),
  };
}
