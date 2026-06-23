import type { Request, Response } from 'express';
import { z } from 'zod';
import { finalizeOnboarding, reopenOnboarding } from '../db/index.js';
import { logger } from '../lib/logger.js';

const SPEC_ID = z.uuid();

// review → active (ADR-022 D6). 'finalized' and 'already-active' both return 200:
// finalize is an idempotent state assertion, friendly to retries (#139).
export async function finalizeSpecHandler(req: Request, res: Response): Promise<void> {
  const id = SPEC_ID.safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    const outcome = await finalizeOnboarding(id.data);
    if (outcome.status === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: { onboardingStatus: 'active' } });
  } catch (err) {
    logger.error({ err }, 'finalize spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

// active → review (ADR-022 D6). 'reopened' and 'already-review' both return 200.
export async function reopenSpecHandler(req: Request, res: Response): Promise<void> {
  const id = SPEC_ID.safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    const outcome = await reopenOnboarding(id.data);
    if (outcome.status === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: { onboardingStatus: 'review' } });
  } catch (err) {
    logger.error({ err }, 'reopen spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
