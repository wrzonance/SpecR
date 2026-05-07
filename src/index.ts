import express from 'express';
import { config } from './lib/env.js';
import { logger } from './lib/logger.js';
import { pool } from './db/index.js';
import { router } from './api/router.js';
import { errorHandler } from './api/middleware/error.js';

const app = express();

app.use(express.json());
app.use(router);
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

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
