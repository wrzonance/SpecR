import pino from 'pino';
import { join } from 'node:path';
import { config } from './env.js';
import type { Config } from './env.js';

type Target = { target: string; level: string; options: Record<string, unknown> };

// Pure so it is unit-testable without spinning a transport worker. Behaviour:
//  - prod/test, no file → plain JSON to stdout (no transport; unchanged from before)
//  - development       → pino-pretty
//  - LOG_TO_FILE       → rotating JSONL file (pino-roll), plus a stdout mirror in prod
export function buildLoggerOptions(cfg: Config): pino.LoggerOptions {
  const targets: Target[] = [];
  if (cfg.NODE_ENV === 'development') {
    targets.push({ target: 'pino-pretty', level: cfg.LOG_LEVEL, options: {} });
  }
  if (cfg.LOG_TO_FILE) {
    if (cfg.NODE_ENV !== 'development') {
      targets.push({ target: 'pino/file', level: cfg.LOG_LEVEL, options: { destination: 1 } });
    }
    targets.push({
      target: 'pino-roll',
      level: cfg.LOG_LEVEL,
      options: {
        // pino-roll@4.0.0's `extension` option is silently ignored (sanitizeFile()
        // is called without forwarding it — see pino-roll.js:92), so the extension
        // must be embedded in `file` itself to actually get .jsonl output.
        file: join(cfg.LOG_DIR, 'specr.jsonl'),
        frequency: 'daily',
        size: '20m',
        mkdir: true,
      },
    });
  }
  return targets.length === 0
    ? { level: cfg.LOG_LEVEL }
    : { level: cfg.LOG_LEVEL, transport: { targets } };
}

export const logger = pino(buildLoggerOptions(config));
