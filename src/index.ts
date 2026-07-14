import express from 'express';
import { config } from './lib/env.js';
import { logger, closeLogger } from './lib/logger.js';
import { isAuthConfigured, logStartupSecurityWarning } from './lib/security-posture.js';
import { pool } from './db/index.js';
import { router } from './api/router.js';
import { errorHandler } from './api/middleware/error.js';
import { registerMcpRoutes } from './mcp/server.js';
import { registerDocsRoutes } from './api/docs.js';
import { createHeaderFooterBodyLimitMiddleware } from './api/header-footer-body-limit.js';

const app = express();
app.disable('x-powered-by');

// REST routes use the default JSON limit; /mcp applies its own larger limit
// route-locally; the four header/footer composition PUT routes get a
// route-scoped limit sized for one base64-encoded image (#490).
app.use(createHeaderFooterBodyLimitMiddleware());
app.use(router);
registerMcpRoutes(app);
registerDocsRoutes(app);
app.use(errorHandler);

// Honest guard until auth lands (#43): the surface binds all interfaces and is
// unauthenticated by design, so warn loudly before we accept traffic.
logStartupSecurityWarning(logger, {
  authConfigured: isAuthConfigured(config),
  mcpTiers: config.MCP_ALLOWED_TIERS,
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'specr started');
});

async function shutdown(): Promise<void> {
  logger.info('shutdown signal received');
  server.close();
  await pool.end();
  logger.info('shutdown complete');
  // Drain the file-transport worker (if any) so buffered JSONL lines survive
  // exit; always terminate even if the flush itself fails.
  try {
    await closeLogger();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
