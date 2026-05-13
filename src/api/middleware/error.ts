import multer from 'multer';
import type { ErrorRequestHandler } from 'express';
import { logger } from '../../lib/logger.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    logger.warn({ err }, 'request rejected by upload validation');
    res.status(400).json({ success: false, error: err.message });
    return;
  }
  logger.error({ err }, 'unhandled error');
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ success: false, error: 'internal server error' });
};
