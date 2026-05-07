import type { ErrorRequestHandler } from 'express';
import { logger } from '../../lib/logger.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, 'unhandled error');
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ success: false, error: 'internal server error' });
};
