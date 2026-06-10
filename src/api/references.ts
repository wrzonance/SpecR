import type { Request, Response } from 'express';
import { deleteReference } from '../db/index.js';
import { logger } from '../lib/logger.js';

// DELETE /specs/:id/references/:refId
// Removes a single cross-reference while leaving its paragraph in place
// (Feature B: "delete the reference only" after an edit removed the citation).
export async function deleteReferenceHandler(req: Request, res: Response): Promise<void> {
  const specId = req.params['id'];
  const refId = req.params['refId'];
  if (!specId || typeof specId !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  if (!refId || typeof refId !== 'string') {
    res.status(400).json({ success: false, error: 'missing reference id' });
    return;
  }
  try {
    const removed = await deleteReference(refId, specId);
    if (!removed) {
      res.status(404).json({ success: false, error: 'reference not found' });
      return;
    }
    res.status(200).json({ success: true, data: { specId, refId } });
  } catch (err) {
    logger.error({ err }, 'delete reference failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
