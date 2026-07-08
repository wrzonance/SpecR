import { logger } from './logger.js';
import type { Logger } from 'pino';

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
