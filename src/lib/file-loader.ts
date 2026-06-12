import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '../parser/index.js';
import { persistParsedSpec, lookupSpecSectionTitle } from '../db/index.js';
import { computeTitleMatch } from './infer-section.js';
import { logger } from './logger.js';
import { sha256Hex } from './hash.js';
import type { SectionInference } from './infer-section.js';

export interface InferenceWarning {
  readonly file: string;
  readonly specId: string;
  readonly inferredSection: string;
  readonly inferredTitle: string;
  readonly standardTitle: string | null;
  readonly titleMatchScore: number | null;
  readonly titleMatch: 'exact' | 'close' | 'divergent' | 'unknown';
  readonly confidence: 'high' | 'medium';
  readonly note: string;
}

export interface LoadResult {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ readonly file: string; readonly error: string }>;
  readonly inferenceWarnings: ReadonlyArray<InferenceWarning>;
}

export interface LoadOptions {
  readonly dryRun?: boolean;
  readonly onProgress?: (done: number, total: number, file: string, ok: boolean) => void;
}

async function resolveStandardTitle(section: string): Promise<string | null> {
  try {
    return await lookupSpecSectionTitle(section);
  } catch {
    return null;
  }
}

async function buildInferenceWarning(
  file: string,
  specId: string,
  inference: SectionInference
): Promise<InferenceWarning | null> {
  if (inference.method === 'metadata' || inference.confidence === 'none') return null;
  const standardTitle = await resolveStandardTitle(inference.inferredSection);
  const { titleMatch, titleMatchScore } = computeTitleMatch(inference.inferredTitle, standardTitle);
  return {
    file,
    specId,
    inferredSection: inference.inferredSection,
    inferredTitle: inference.inferredTitle,
    standardTitle,
    titleMatchScore: titleMatchScore ?? null,
    titleMatch,
    confidence: inference.confidence,
    note: 'Section metadata missing. Section number and title inferred from document content. Standard title (if present) sourced from UFGS reference corpus — not authoritative CSI MasterFormat. Please verify.',
  };
}

function fireProgress(
  opts: LoadOptions | undefined,
  done: number,
  total: number,
  file: string,
  ok: boolean
): void {
  try {
    opts?.onProgress?.(done, total, file, ok);
  } catch (err) {
    logger.warn({ err, file }, 'loadFiles onProgress callback failed');
  }
}

async function processFile(
  file: string,
  dryRun: boolean,
  inferenceWarnings: InferenceWarning[]
): Promise<void> {
  const buffer = await readFile(file);
  const result = await parse(buffer, file);
  if (dryRun) return;
  const originMeta = {
    filename: path.basename(file),
    sha256: sha256Hex(buffer),
    loader: 'load_files',
  };
  const specId = await persistParsedSpec({ ...result, originMeta });
  const warning = await buildInferenceWarning(file, specId, result.sectionInference);
  if (warning) inferenceWarnings.push(warning);
}

export async function loadFiles(paths: readonly string[], opts?: LoadOptions): Promise<LoadResult> {
  const total = paths.length;
  if (total === 0) return { total: 0, succeeded: 0, failed: 0, errors: [], inferenceWarnings: [] };

  let succeeded = 0;
  let failed = 0;
  const errors: Array<{ readonly file: string; readonly error: string }> = [];
  const inferenceWarnings: InferenceWarning[] = [];
  let done = 0;

  for (const file of paths) {
    let ok = false;
    try {
      await processFile(file, opts?.dryRun ?? false, inferenceWarnings);
      succeeded++;
      ok = true;
    } catch (err) {
      failed++;
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
    done++;
    fireProgress(opts, done, total, file, ok);
  }

  return { total, succeeded, failed, errors, inferenceWarnings };
}
