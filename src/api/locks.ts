import type { Request, Response } from 'express';
import { z } from 'zod';
import { AcquireLockBodySchema, ReleaseLockBodySchema } from '../ast/index.js';
import { acquireLock, releaseLock, getLock, findSpecById } from '../db/index.js';
import { logger } from '../lib/logger.js';

/** Advisory soft-lock endpoints (ADR-018 D2). These are visibility hints
 *  ("someone is editing this section"), not pessimistic checkout (ADR-005):
 *  they never block a write on their own. The composed edit gate, not the lock,
 *  is what governs whether a write is allowed. */

function parseSpecId(req: Request, res: Response): string | null {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return null;
  }
  return id.data;
}

/** PUT /specs/:id/lock — acquire (or refresh / steal-after-expiry). 200 when
 *  acquired; 409 with the blocking holder when a live lock is held by another. */
export async function acquireLockHandler(req: Request, res: Response): Promise<void> {
  const specId = parseSpecId(req, res);
  if (specId === null) return;
  const body = AcquireLockBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'holder is required' });
    return;
  }
  try {
    if (!(await findSpecById(specId))) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    const result = await acquireLock(specId, body.data.holder, body.data.ttlSeconds);
    if (result.status === 'held') {
      res.status(409).json({
        success: false,
        error: `spec is locked by ${result.holder}`,
        holder: result.holder,
        expiresAt: result.expiresAt,
      });
      return;
    }
    res.status(200).json({ success: true, data: result.lock });
  } catch (err) {
    logger.error({ err }, 'acquire lock failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

/** DELETE /specs/:id/lock — release. 200 when the caller's lock was released;
 *  409 when no lock is held by this caller (nothing to release / held by another). */
export async function releaseLockHandler(req: Request, res: Response): Promise<void> {
  const specId = parseSpecId(req, res);
  if (specId === null) return;
  const body = ReleaseLockBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'holder is required' });
    return;
  }
  try {
    const result = await releaseLock(specId, body.data.holder);
    if (!result.released) {
      res.status(409).json({ success: false, error: 'no lock held by this holder' });
      return;
    }
    res.status(200).json({ success: true, data: { released: true } });
  } catch (err) {
    logger.error({ err }, 'release lock failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

/** GET /specs/:id/lock — current live lock (expired locks read as free). */
export async function getLockHandler(req: Request, res: Response): Promise<void> {
  const specId = parseSpecId(req, res);
  if (specId === null) return;
  try {
    const lock = await getLock(specId);
    res.status(200).json({ success: true, data: { locked: lock !== null, lock } });
  } catch (err) {
    logger.error({ err }, 'get lock failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
