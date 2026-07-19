import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getParagraphHistory,
  getSpecHistory,
  getSpecHistoryDiff,
  HistoryAnchorError,
} from '../db/index.js';
import { HistoryAnchorSchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';

const IncludeOriginSchema = z.enum(['true', 'false']).optional();
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

export async function getParagraphHistoryHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  const includeOrigin = IncludeOriginSchema.safeParse(req.query['includeOrigin']);
  if (!specId.success || !nodeId.success || !includeOrigin.success) {
    badRequest(res, 'invalid history request');
    return;
  }
  try {
    const history = await getParagraphHistory(
      specId.data,
      nodeId.data,
      includeOrigin.data === 'true'
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
