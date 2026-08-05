import type { Request, Response } from 'express';
import { z } from 'zod';
import { PatchAcknowledgementBodySchema } from '../ast/index.js';
import { setParagraphAcknowledged } from '../db/index.js';
import { gateErrorResponse } from './edit-gate-response.js';
import { logger } from '../lib/logger.js';

/**
 * PATCH /specs/:id/paragraphs/:nodeId/acknowledgement — per-node
 * acknowledgement (#545, ADR-079 follow-on). `{ acknowledged: true }` clears
 * the readiness gate's `specifier_note_present` / `body_object_present`
 * finding for a `note` or `textBox` `object` node WITHOUT removing or hiding
 * the content — it still renders exactly as before. Only `note` nodes and
 * `textBox`-kind `object` nodes are acknowledgeable; every other node type
 * (including a `table`-kind object, ADR-072) is rejected 422. The toggle is
 * idempotent — a no-op returns the node unchanged without bumping any
 * version. Passes the composed edit gate (ADR-018): archived/upstream-locked
 * → 409. Mirrors removeParagraphHandler's structure exactly.
 */
export async function acknowledgeParagraphHandler(req: Request, res: Response): Promise<void> {
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
  const body = PatchAcknowledgementBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'acknowledged must be a boolean' });
    return;
  }

  try {
    const result = await setParagraphAcknowledged(
      specId.data,
      nodeId.data,
      body.data.acknowledged,
      body.data.actorLabel
    );
    switch (result.status) {
      case 'not-found':
        res.status(404).json({ success: false, error: 'paragraph not found' });
        return;
      case 'wrong-spec':
        res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
        return;
      case 'not-acknowledgeable':
        res.status(422).json({
          success: false,
          error: `node type "${result.nodeType}" cannot be acknowledged — only note nodes and textBox objects are`,
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
    logger.error({ err }, 'acknowledge paragraph failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
