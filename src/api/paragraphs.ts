import type { Request, Response } from 'express';
import { z } from 'zod';
import { UpdateParagraphBodySchema } from '../ast/index.js';
import {
  updateParagraphText,
  SpecNotFoundError,
  SpecWriteForbiddenError,
  StaleVersionError,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

/** Map an edit-gate error to its HTTP response, or null if not a gate error.
 *  Stale version → 409 with the current version so the client can refetch and
 *  retry; forbidden (archived / upstream-locked) → 409; missing spec → 404. */
function gateErrorResponse(
  err: unknown
): { readonly status: number; readonly body: Record<string, unknown> } | null {
  if (err instanceof StaleVersionError) {
    return {
      status: 409,
      body: { success: false, error: err.message, currentVersion: err.currentVersion },
    };
  }
  if (err instanceof SpecWriteForbiddenError) {
    return { status: 409, body: { success: false, error: err.message } };
  }
  if (err instanceof SpecNotFoundError) {
    return { status: 404, body: { success: false, error: 'spec not found' } };
  }
  return null;
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
