import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  PatchEditabilityBodySchema,
  ReclassifyBodySchema,
  AcceptNoteBodySchema,
  PatchCommentClosureBodySchema,
} from '../ast/index.js';
import type { ConventionRules, Editability } from '../ast/index.js';
import {
  setSpecEditabilityOverride,
  clearSpecEditabilityOverride,
  reclassifySpec,
  acceptCommentAsNote,
  setParagraphCommentClosed,
  ConventionValidationError,
} from '../db/index.js';
import type { OwnershipResult, AcceptNoteOutcome, SetCommentClosedResult } from '../db/index.js';
import { gateErrorResponse } from './edit-gate-response.js';
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

function respondEditability(res: Response, nodeId: string, editability: Editability | null): void {
  res.status(200).json({ success: true, data: { nodeId, editability } });
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
    if (editability === null) {
      const result = await clearSpecEditabilityOverride(ids.specId, ids.nodeId);
      if (sendOwnershipError(result, res)) return;
      respondEditability(res, ids.nodeId, null);
      return;
    }
    const result = await setSpecEditabilityOverride(ids.specId, ids.nodeId, editability);
    // object/objectText editability is fixed at capture time (ADR-072 D2) — never
    // overridable, so this predates the ownership check's not-found/wrong-spec pair.
    if (result.status === 'fixed-node-type') {
      res.status(422).json({
        success: false,
        error: `node type "${result.nodeType}" has fixed editability and cannot be overridden`,
      });
      return;
    }
    if (sendOwnershipError(result, res)) return;
    respondEditability(res, ids.nodeId, editability);
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
  // Only a truly absent body (undefined) means "omit rules → resolve the stored
  // profile". An explicit non-object payload (e.g. JSON `null`) must fall through
  // to the schema and be rejected — never coerced to {} and silently run.
  const body = ReclassifyBodySchema.safeParse(req.body === undefined ? {} : req.body);
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
    // Request-supplied rules carrying an unsafe regex are rejected at the
    // DB boundary (ADR-022 D5) — map to 422, same as the convention CRUD path.
    if (err instanceof ConventionValidationError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
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
  // The route was bodyless pre-#377 (the target comment is identified entirely by path
  // params); a truly absent body still resolves to {}, matching that contract byte for
  // byte — actorLabel (#377) is the only field this schema accepts. Only `undefined`
  // (a genuinely absent body) coerces to {}; a literal JSON `null` falls through to the
  // schema and is rejected, mirroring reclassifyHandler's guard above — the strict
  // body-parser already 400s a bare `null` at parse time, so this is the same
  // in-handler safety net, never a coercion to {}.
  const body = AcceptNoteBodySchema.safeParse(req.body === undefined ? {} : req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'invalid accept-as-note body' });
    return;
  }
  try {
    const outcome = await acceptCommentAsNote(
      ids.specId,
      ids.nodeId,
      index.data,
      body.data.actorLabel
    );
    sendAcceptOutcome(outcome, res);
  } catch (err) {
    // The note insert passes the composed edit gate (ADR-018): an archived or
    // upstream-locked spec → 409, mirroring every other content-write handler.
    const gate = gateErrorResponse(err);
    if (gate) {
      res.status(gate.status).json(gate.body);
      return;
    }
    logger.error({ err }, 'accept-as-note failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

// ── comment closure ────────────────────────────────────────────────────────

function sendCommentClosedResult(res: Response, result: SetCommentClosedResult): void {
  switch (result.status) {
    case 'not-found':
      res.status(404).json({ success: false, error: 'paragraph not found' });
      return;
    case 'wrong-spec':
      res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
      return;
    case 'no-comment':
      // A lookup miss ("nothing exists at this index to toggle"), not a
      // validation failure — mirrors `not-found` rather than acceptAsNoteHandler's
      // 422 for "you tried to create something with no material".
      res.status(404).json({ success: false, error: 'no comment at that index' });
      return;
    case 'updated':
      res.status(200).json({ success: true, data: result.node });
      return;
  }
}

/**
 * PATCH /specs/:id/paragraphs/:nodeId/comments/:index/closure — a mutable
 * comment-closure toggle (#545, ADR-079 follow-on): the only supported path
 * to clear `open_comment` on an existing spec. `{ closed: true }` closes the
 * comment at `index`; `false` reopens it. Idempotent — a no-op returns the
 * node unchanged without bumping any version. Passes the composed edit gate
 * (ADR-018): archived/upstream-locked → 409.
 */
export async function closeCommentHandler(req: Request, res: Response): Promise<void> {
  const ids = parseIds(req, res);
  if (!ids) return;
  const index = INDEX_SCHEMA.safeParse(req.params['index']);
  if (!index.success) {
    res.status(400).json({ success: false, error: 'invalid comment index' });
    return;
  }
  const body = PatchCommentClosureBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'closed must be a boolean' });
    return;
  }
  try {
    const result = await setParagraphCommentClosed(
      ids.specId,
      ids.nodeId,
      index.data,
      body.data.closed,
      body.data.actorLabel
    );
    sendCommentClosedResult(res, result);
  } catch (err) {
    const gate = gateErrorResponse(err);
    if (gate) {
      res.status(gate.status).json(gate.body);
      return;
    }
    logger.error({ err }, 'close comment failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
