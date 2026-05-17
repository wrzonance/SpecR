import { readFile } from 'node:fs/promises';
import { parse } from '../parser/index.js';
import { persistParsedSpec } from '../db/index.js';
import { logger } from './logger.js';

export interface LoadResult {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ readonly file: string; readonly error: string }>;
}

export interface LoadOptions {
  readonly dryRun?: boolean;
  readonly onProgress?: (done: number, total: number, file: string, ok: boolean) => void;
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

export async function loadFiles(paths: readonly string[], opts?: LoadOptions): Promise<LoadResult> {
  const total = paths.length;
  if (total === 0) return { total: 0, succeeded: 0, failed: 0, errors: [] };

  let succeeded = 0;
  let failed = 0;
  const errors: Array<{ readonly file: string; readonly error: string }> = [];
  let done = 0;

  for (const file of paths) {
    let ok = false;
    try {
      const buffer = await readFile(file);
      const result = await parse(buffer, file);
      if (!opts?.dryRun) {
        await persistParsedSpec(result);
      }
      succeeded++;
      ok = true;
    } catch (err) {
      failed++;
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
    done++;
    fireProgress(opts, done, total, file, ok);
  }

  return { total, succeeded, failed, errors };
}
