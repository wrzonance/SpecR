import type { Request, Response } from 'express';
import { z } from 'zod';
import { PatchEditabilityBodySchema } from '../ast/index.js';
import { setSpecEditabilityOverride, clearSpecEditabilityOverride } from '../db/index.js';
import type { OwnershipResult } from '../db/index.js';
import { logger } from '../lib/logger.js';

// Validate the two UUID params; reply 400 and return null on a malformed id.
function parseIds(req: Request, res: Response): { specId: string; nodeId: string } | null {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return null;
  }
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  if (!nodeId.success) {
    res.status(400).json({ success: false, error: 'invalid node id' });
    return null;
  }
  return { specId: specId.data, nodeId: nodeId.data };
}

// Map a query ownership result to the matching HTTP error; returns true when the
// caller has already responded (non-ok), false when status is 'ok'.
function sendOwnershipError(result: OwnershipResult, res: Response): boolean {
  if (result.status === 'not-found') {
    res.status(404).json({ success: false, error: 'paragraph not found' });
    return true;
  }
  if (result.status === 'wrong-spec') {
    res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
    return true;
  }
  return false;
}

export async function patchEditabilityHandler(req: Request, res: Response): Promise<void> {
  const ids = parseIds(req, res);
  if (!ids) return;
  const body = PatchEditabilityBodySchema.safeParse(req.body);
  if (!body.success) {
    res
      .status(400)
      .json({ success: false, error: 'editability must be locked|editable|choice|note or null' });
    return;
  }
  try {
    const { editability } = body.data;
    const result =
      editability === null
        ? await clearSpecEditabilityOverride(ids.specId, ids.nodeId)
        : await setSpecEditabilityOverride(ids.specId, ids.nodeId, editability);
    if (sendOwnershipError(result, res)) return;
    res.status(200).json({ success: true, data: { nodeId: ids.nodeId, editability } });
  } catch (err) {
    logger.error({ err }, 'patch editability failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
