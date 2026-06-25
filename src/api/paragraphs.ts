import type { Request, Response } from 'express';
import { z } from 'zod';
import { UpdateParagraphBodySchema, PatchRemovalBodySchema } from '../ast/index.js';
import { updateParagraphText, setParagraphVanish } from '../db/index.js';
import { gateErrorResponse } from './edit-gate-response.js';
import { logger } from '../lib/logger.js';

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

/**
 * PATCH /specs/:id/paragraphs/:nodeId/removal — the editability program's
 * reversible removal (#251, ADR-022). `{ removed: true }` sets `meta.vanish`
 * (suppress from the owner-facing DOCX/Markdown renders, keep the row + subtree +
 * contained refs; the lossless `.SEC` serialization preserves the flag);
 * `false` reverses it. Only body paragraphs are removable: a structural heading
 * or `note` node the owner-facing renderers cannot hide is rejected 422. The
 * toggle is idempotent — a no-op returns the node unchanged without bumping any
 * version. Passes the composed edit gate (ADR-018): archived/upstream-locked →
 * 409. A separate sub-route from the text-replacement PATCH — removal is a
 * lifecycle action, not a text edit, and must not require a non-empty `text`.
 */
export async function removeParagraphHandler(req: Request, res: Response): Promise<void> {
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
  const body = PatchRemovalBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'removed must be a boolean' });
    return;
  }

  try {
    const result = await setParagraphVanish(specId.data, nodeId.data, body.data.removed);
    switch (result.status) {
      case 'not-found':
        res.status(404).json({ success: false, error: 'paragraph not found' });
        return;
      case 'wrong-spec':
        res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
        return;
      case 'not-removable':
        res.status(422).json({
          success: false,
          error: `node type "${result.nodeType}" cannot be removed — only body paragraphs are render-suppressible`,
        });
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
    logger.error({ err }, 'remove paragraph failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
