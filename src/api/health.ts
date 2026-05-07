import type { Request, Response } from 'express'
import { pingDatabase, pool } from '../db/index.js'
import { logger } from '../lib/logger.js'

export async function healthHandler(_req: Request, res: Response): Promise<void> {
  try {
    await pingDatabase(pool)
    res.status(200).json({
      success: true,
      data: { db: 'connected', uptime: Math.floor(process.uptime()) },
    })
  } catch (err) {
    logger.error({ err }, 'health check failed')
    res.status(503).json({ success: false, error: 'database unavailable' })
  }
}
