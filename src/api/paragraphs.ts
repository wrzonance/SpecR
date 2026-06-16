import type { Request, Response } from 'express';
import { z } from 'zod';
import { UpdateParagraphBodySchema } from '../ast/index.js';
import { updateParagraphText } from '../db/index.js';
import { logger } from '../lib/logger.js';

/**
 * PATCH /specs/:id/paragraphs/:nodeId — update a single paragraph's text by UUID
 * (ADR-009, #47). Bumps `base_version`; the Revit add-in (#48) calls this to push
 * a model-parameter change without replacing the whole spec.
 */
export async function updateParagraphHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  if (!nodeId.success) {
    res.status(400).json({ success: false, error: 'invalid node id' });
    return;
  }
  const body = UpdateParagraphBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'text must be a non-empty string' });
    return;
  }

  try {
    const result = await updateParagraphText(specId.data, nodeId.data, body.data.text);
    switch (result.status) {
      case 'not-found':
        res.status(404).json({ success: false, error: 'paragraph not found' });
        return;
      case 'wrong-spec':
        res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
        return;
      case 'updated':
        res.status(200).json({ success: true, data: result.node });
        return;
    }
  } catch (err) {
    logger.error({ err }, 'update paragraph failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
