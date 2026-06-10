import type { Request, Response } from 'express';
import { deleteParagraph, updateParagraphText } from '../db/index.js';
import type { UpdateParagraphBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';

// DELETE /specs/:id/paragraphs/:paragraphId
// Removes a paragraph; the schema cascade also drops any references it contained
// and any descendant paragraphs (Feature A: "delete the paragraph + its citation").
export async function deleteParagraphHandler(req: Request, res: Response): Promise<void> {
  const specId = req.params['id'];
  const paragraphId = req.params['paragraphId'];
  if (!specId || typeof specId !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  if (!paragraphId || typeof paragraphId !== 'string') {
    res.status(400).json({ success: false, error: 'missing paragraph id' });
    return;
  }
  try {
    const removed = await deleteParagraph(paragraphId, specId);
    if (!removed) {
      res.status(404).json({ success: false, error: 'paragraph not found' });
      return;
    }
    res.status(200).json({ success: true, data: { specId, paragraphId } });
  } catch (err) {
    logger.error({ err }, 'delete paragraph failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

// PATCH /specs/:id/paragraphs/:paragraphId  body: { text }
// Replaces a paragraph's body text (Feature B inline editor). References are
// left intact — the client deletes any the edit removed via the reference route.
export async function updateParagraphHandler(req: Request, res: Response): Promise<void> {
  const specId = req.params['id'];
  const paragraphId = req.params['paragraphId'];
  if (!specId || typeof specId !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  if (!paragraphId || typeof paragraphId !== 'string') {
    res.status(400).json({ success: false, error: 'missing paragraph id' });
    return;
  }
  try {
    const body = req.body as UpdateParagraphBody;
    const updated = await updateParagraphText(paragraphId, specId, body.text);
    if (!updated) {
      res.status(404).json({ success: false, error: 'paragraph not found' });
      return;
    }
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    logger.error({ err }, 'update paragraph failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
