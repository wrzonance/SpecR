import { logger } from './logger.js';
import type { Logger } from 'pino';
import type { ParseWarning } from '../ast/types.js';

export interface ParseLogFields {
  readonly filename: string;
  readonly sha256: string;
  readonly loader: string;
  readonly specId?: string;
  readonly jobId?: string;
}

// Per-document child logger. Untrusted values (filename) are namespaced under an
// app-controlled `doc` key so they can never overwrite reserved pino fields.
export function parseLog(fields: ParseLogFields): Logger {
  return logger.child({ doc: { ...fields } });
}

// Single home for the parse-warning log side-effect: every ingest path (MCP,
// load_files, REST parse, onboarding) emits the same event with the same message
// on its per-document child logger. No-op when there are no warnings.
export function logParseWarnings(log: Logger, warnings: readonly ParseWarning[]): void {
  if (warnings.length > 0) log.warn({ warnings }, 'parse produced warnings');
}
