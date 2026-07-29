import type { Request, Response } from 'express';
import { z } from 'zod';
import { rejectParagraphToCheckpoint, lockedObjectMessage } from '../db/index.js';
import type { RejectParagraphResult } from '../db/index.js';
import { RejectParagraphBodySchema } from '../ast/index.js';
import { gateErrorResponse } from './edit-gate-response.js';
import { logger } from '../lib/logger.js';

// ADR-052 D4 (issue #380, task 9) — per-paragraph reject: revert pending edits
// to the last-checkpoint state, shipped as a restore-to-version write through
// the existing paragraph PATCH machinery (rejectParagraphToCheckpoint). The
// revert is unconditional (no expectedVersion), so the only write-gate errors
// that can still surface are an archived/upstream-locked spec — the same
// gateErrorResponse mapping updateParagraphHandler uses for its own call to
// updateParagraphText.

function badRequest(res: Response, error: string): void {
  res.status(400).json({ success: false, error });
}

/** Maps {@link RejectParagraphResult} to its REST response. `not-found`,
 *  `wrong-spec`, and `locked-object` mirror updateParagraphHandler's own
 *  UpdateParagraphResult mapping verbatim (paragraphs.ts) — the DB layer
 *  reuses updateParagraphText internally, so these are the exact same
 *  failure modes. `checkpoint-not-found` is a 404 (no such sealed boundary
 *  for this spec); `no-checkpointed-state` is a 422 (nothing recorded to
 *  revert this paragraph to). */
function sendRejectResult(res: Response, result: RejectParagraphResult): void {
  switch (result.status) {
    case 'reverted':
      res.status(200).json({ success: true, data: result.node });
      return;
    case 'not-found':
      res.status(404).json({ success: false, error: 'paragraph not found' });
      return;
    case 'wrong-spec':
      res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
      return;
    case 'locked-object':
      res.status(422).json({ success: false, error: lockedObjectMessage(result.nodeType) });
      return;
    case 'checkpoint-not-found':
      res
        .status(404)
        .json({ success: false, error: 'checkpoint not found, or never sealed this spec' });
      return;
    case 'no-checkpointed-state':
      res.status(422).json({
        success: false,
        error: 'no recorded state for this paragraph at or before that checkpoint',
      });
      return;
  }
}

/**
 * PATCH /specs/:id/paragraphs/:nodeId/reject — revert one paragraph to the
 * text it held at `checkpointId`'s sealed contentVersion (ADR-052 D4). The
 * write is unconditional: an edit made after the checkpoint sealed is
 * discarded, never blocked by a stale-version conflict.
 */
export async function rejectParagraphHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    badRequest(res, 'invalid spec id');
    return;
  }
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  if (!nodeId.success) {
    badRequest(res, 'invalid node id');
    return;
  }
  const body = RejectParagraphBodySchema.safeParse(req.body);
  if (!body.success) {
    badRequest(res, 'checkpointId (uuid) is required');
    return;
  }

  try {
    const result = await rejectParagraphToCheckpoint(
      specId.data,
      nodeId.data,
      body.data.checkpointId,
      body.data.actorLabel
    );
    sendRejectResult(res, result);
  } catch (err) {
    const gate = gateErrorResponse(err);
    if (gate) {
      res.status(gate.status).json(gate.body);
      return;
    }
    logger.error({ err }, 'reject paragraph failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
