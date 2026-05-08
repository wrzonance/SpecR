import type { Request, Response } from 'express';
import { findSpecById, updateSpec } from '../db/queries/specs.js';
import type { UpdateSpecInput } from '../db/queries/specs.js';
import { logger } from '../lib/logger.js';

export async function getSpecHandler(req: Request, res: Response): Promise<void> {
  const idParam = req.params['id'];
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  if (!id) {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  try {
    const spec = await findSpecById(id);
    if (!spec) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: spec });
  } catch (err) {
    logger.error({ err }, 'get spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function updateSpecHandler(req: Request, res: Response): Promise<void> {
  const idParam = req.params['id'];
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  if (!id) {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  try {
    const body = req.body as UpdateSpecInput;
    const spec = await updateSpec(id, body);
    if (!spec) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: spec });
  } catch (err) {
    logger.error({ err }, 'update spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
