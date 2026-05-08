import pino from 'pino';
import { config } from './env.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
});
