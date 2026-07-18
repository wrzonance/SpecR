import type { Request, Response } from 'express';
import { z } from 'zod';
import { MergeBodySchema } from '../ast/index.js';
import { applyMerge, InvalidAcceptedChangeError, MergeError } from '../merge/index.js';
import { gateErrorResponse } from './edit-gate-response.js';
import { logger } from '../lib/logger.js';

/** Map a merge-path error to its HTTP response, or null to fall through to the
 *  500 path. Edit-gate errors (ADR-018) first, then merge-specific errors. */
function mergeErrorResponse(
  err: unknown
): { readonly status: number; readonly body: Record<string, unknown> } | null {
  const gate = gateErrorResponse(err);
  if (gate) return gate;
  if (err instanceof InvalidAcceptedChangeError) {
    return { status: 400, body: { success: false, error: err.message } };
  }
  if (err instanceof MergeError) {
    return { status: 409, body: { success: false, error: err.message } };
  }
  return null;
}

export async function mergeHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const bodyResult = MergeBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid merge request body' });
    return;
  }
  try {
    // The transaction, composed edit gate (ADR-018), applyAccepted, and content_version
    // bump all live in the shared applyMerge service (src/merge) — one orchestration for
    // both the REST route and the apply_merge MCP tool.
    // objectConflicts (#520) isn't part of MergeBodySchema/DiffResultSchema yet — a
    // client-supplied diff never carries structural conflicts to accept, so this
    // defaults it to [] rather than widening the wire schema ahead of that work.
    const outcome = await applyMerge(
      idResult.data,
      bodyResult.data.accept,
      { ...bodyResult.data.diff, objectConflicts: [] },
      bodyResult.data.expectedVersion,
      bodyResult.data.actorLabel
    );
    if (outcome.kind === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res
      .status(200)
      .json({ success: true, data: { applied: outcome.applied, rejected: outcome.rejected } });
  } catch (err) {
    const mapped = mergeErrorResponse(err);
    if (mapped) {
      res.status(mapped.status).json(mapped.body);
      return;
    }
    logger.error({ err }, 'merge failed');
    res.status(500).json({ success: false, error: 'merge failed' });
  }
}
