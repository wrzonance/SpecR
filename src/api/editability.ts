import type { Request, Response } from 'express';
import { z } from 'zod';
import { PatchEditabilityBodySchema, ReclassifyBodySchema } from '../ast/index.js';
import type { ConventionRules } from '../ast/index.js';
import {
  setSpecEditabilityOverride,
  clearSpecEditabilityOverride,
  reclassifySpec,
  acceptCommentAsNote,
} from '../db/index.js';
import type { OwnershipResult, AcceptNoteOutcome } from '../db/index.js';
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

export async function reclassifyHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const body = ReclassifyBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'malformed reclassify body' });
    return;
  }
  try {
    const opts: { rules?: ConventionRules; preview?: boolean } = {};
    if (body.data.rules !== undefined) opts.rules = body.data.rules;
    if (body.data.preview !== undefined) opts.preview = body.data.preview;
    const outcome = await reclassifySpec(specId.data, opts);
    if (outcome.status === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    if (outcome.status === 'no-convention') {
      res
        .status(422)
        .json({ success: false, error: 'no convention profile resolvable; supply rules' });
      return;
    }
    res.status(200).json({ success: true, data: outcome.report });
  } catch (err) {
    logger.error({ err }, 'reclassify failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

const INDEX_SCHEMA = z.coerce.number().int().nonnegative();

function sendAcceptOutcome(outcome: AcceptNoteOutcome, res: Response): void {
  switch (outcome.status) {
    case 'created':
      res.status(201).json({ success: true, data: { noteId: outcome.noteId } });
      return;
    case 'already-accepted':
      res
        .status(409)
        .json({ success: false, error: 'comment already accepted', noteId: outcome.noteId });
      return;
    case 'not-found':
      res.status(404).json({ success: false, error: 'paragraph not found' });
      return;
    case 'wrong-spec':
      res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
      return;
    case 'no-comment':
      res.status(422).json({ success: false, error: 'no comment at that index' });
      return;
  }
}

export async function acceptAsNoteHandler(req: Request, res: Response): Promise<void> {
  const ids = parseIds(req, res);
  if (!ids) return;
  const index = INDEX_SCHEMA.safeParse(req.params['index']);
  if (!index.success) {
    res.status(400).json({ success: false, error: 'invalid comment index' });
    return;
  }
  try {
    const outcome = await acceptCommentAsNote(ids.specId, ids.nodeId, index.data);
    sendAcceptOutcome(outcome, res);
  } catch (err) {
    logger.error({ err }, 'accept-as-note failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
