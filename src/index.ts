import express from 'express';
import { config } from './lib/env.js';
import { logger } from './lib/logger.js';
import { pool } from './db/index.js';
import { router } from './api/router.js';
import { errorHandler } from './api/middleware/error.js';
import { registerMcpRoutes } from './mcp/server.js';

const app = express();
app.disable('x-powered-by');

// REST routes use default JSON limit; /mcp applies its own larger limit route-locally
const restJson = express.json();
app.use((req, res, next) => {
  if (req.path.startsWith('/mcp')) return next();
  restJson(req, res, next);
});
app.use(router);
registerMcpRoutes(app);
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'specr started');
});

async function shutdown(): Promise<void> {
  logger.info('shutdown signal received');
  server.close();
  await pool.end();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
