import pino from 'pino';
import { join } from 'node:path';
import { once } from 'node:events';
import { config } from './env.js';
import type { Config } from './env.js';

type Target = { target: string; level: string; options: Record<string, unknown> };

// Pure target list — the single source of truth for both buildLoggerOptions
// (unit-tested) and the production transport handle constructed below.
function buildLoggerTargets(cfg: Config): Target[] {
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
  return targets;
}

// Pure so it is unit-testable without spinning a transport worker. Behaviour:
//  - prod/test, no file → plain JSON to stdout (no transport; unchanged from before)
//  - development       → pino-pretty
//  - LOG_TO_FILE       → rotating JSONL file (pino-roll), plus a stdout mirror in prod
export function buildLoggerOptions(cfg: Config): pino.LoggerOptions {
  const targets = buildLoggerTargets(cfg);
  return targets.length === 0
    ? { level: cfg.LOG_LEVEL }
    : { level: cfg.LOG_LEVEL, transport: { targets } };
}

// Build the transport explicitly (rather than inline via `transport:` options) so
// we hold a handle to the worker thread and can drain it on shutdown. Undefined
// when logging straight to stdout — there is no worker to flush in that case.
const runtimeTargets = buildLoggerTargets(config);
const transport =
  runtimeTargets.length > 0 ? pino.transport({ targets: runtimeTargets }) : undefined;

export const logger: pino.Logger = transport
  ? pino({ level: config.LOG_LEVEL }, transport)
  : pino({ level: config.LOG_LEVEL });

// The file transport (pino-roll) runs on a worker thread that buffers writes. A
// bare process.exit() during graceful shutdown can kill that worker before its
// buffer flushes, dropping the final JSONL lines — including parse warnings — that
// the corpus/fix-loop reads back after a run. Drain it explicitly before exit.
// No-op (resolves immediately) when logging to stdout, where there is no worker.
export async function closeLogger(): Promise<void> {
  if (!transport) return;
  transport.end();
  await once(transport, 'close');
}
