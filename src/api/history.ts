import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getParagraphHistory,
  getCoalescedParagraphHistory,
  getSpecHistory,
  getSpecHistoryDiff,
  HistoryAnchorError,
} from '../db/index.js';
import type { ParagraphHistoryEntry, ParagraphHistorySession } from '../db/index.js';
import { HistoryAnchorSchema } from '../ast/index.js';
import { config } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const PackageIdSchema = z.uuid().optional();

function badRequest(res: Response, error: string): void {
  res.status(400).json({ success: false, error });
}

function notFound(res: Response, error: string): void {
  res.status(404).json({ success: false, error });
}

function internalError(res: Response, err: unknown, operation: string): void {
  logger.error({ err }, `${operation} failed`);
  res.status(500).json({ success: false, error: 'internal server error' });
}

/** Tier-0 raw iterations (`?raw=true`) or, by default, tier-1 coalesced
 *  sessions (ADR-052 D3/D9) — the read-time view folds consecutive same-actor
 *  edits into one session with a net before/after diff, still carrying the
 *  raw span as each session's nested `entries` for drill-down. */
async function loadParagraphHistory(
  specId: string,
  nodeId: string,
  includeOrigin: boolean,
  raw: boolean
): Promise<readonly ParagraphHistoryEntry[] | readonly ParagraphHistorySession[] | null> {
  if (raw) return getParagraphHistory(specId, nodeId, includeOrigin);
  return getCoalescedParagraphHistory(
    specId,
    nodeId,
    config.HISTORY_SESSION_WINDOW_MS,
    includeOrigin
  );
}

export async function getParagraphHistoryHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  if (!specId.success || !nodeId.success) {
    badRequest(res, 'invalid history request');
    return;
  }
  try {
    const history = await loadParagraphHistory(
      specId.data,
      nodeId.data,
      req.query['includeOrigin'] === 'true',
      req.query['raw'] === 'true'
    );
    if (!history) {
      notFound(res, 'spec or paragraph not found');
      return;
    }
    res.status(200).json({ success: true, data: history });
  } catch (err) {
    internalError(res, err, 'get paragraph history');
  }
}

export async function getSpecHistoryHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  const packageId = PackageIdSchema.safeParse(req.query['packageId']);
  if (!specId.success || !packageId.success) {
    badRequest(res, 'invalid spec history request');
    return;
  }
  try {
    const history = await getSpecHistory(specId.data, packageId.data);
    if (!history) {
      notFound(res, 'spec not found');
      return;
    }
    res.status(200).json({ success: true, data: history });
  } catch (err) {
    internalError(res, err, 'get spec history');
  }
}

export async function getHistoryDiffHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  const from = HistoryAnchorSchema.safeParse(req.query['from']);
  const to = HistoryAnchorSchema.safeParse(req.query['to']);
  if (!specId.success || !from.success || !to.success) {
    badRequest(res, 'invalid history diff request');
    return;
  }
  try {
    const diff = await getSpecHistoryDiff(specId.data, from.data, to.data);
    if (!diff) {
      notFound(res, 'spec not found');
      return;
    }
    res.status(200).json({ success: true, data: diff });
  } catch (err) {
    if (err instanceof HistoryAnchorError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    internalError(res, err, 'get history diff');
  }
}
