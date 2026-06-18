import type { Request, Response } from 'express';
import { z } from 'zod';
import { UpdateParagraphBodySchema } from '../ast/index.js';
import { deleteParagraph, updateParagraphText } from '../db/index.js';
import { gateErrorResponse } from './edit-gate-response.js';
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

/**
 * PATCH /specs/:id/paragraphs/:nodeId — update a single paragraph's text by UUID
 * (ADR-009, #47). The body may carry `expectedVersion` (ADR-018 D1): a stale
 * value is rejected 409 with the current version. The Revit add-in (#48) calls
 * this to push a model-parameter change without replacing the whole spec.
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
    const result = await updateParagraphText(
      specId.data,
      nodeId.data,
      body.data.text,
      body.data.expectedVersion
    );
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
    const gate = gateErrorResponse(err);
    if (gate) {
      res.status(gate.status).json(gate.body);
      return;
    }
    logger.error({ err }, 'update paragraph failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
