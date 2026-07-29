import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getSpecPendingSummary,
  getProjectPendingSummary,
  SpecNotFoundError,
  ProjectNotFoundError,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

// ADR-052 D9 (issue #380, task 9) — pending-change summaries: everything a
// spec (or every spec in a project) has accumulated since its last checkpoint,
// mirroring open-comments.ts's spec/project read pair. Pure reads; no writes.

function badRequest(res: Response, error: string): void {
  res.status(400).json({ success: false, error });
}

function mapError(err: unknown, res: Response, operation: string): void {
  if (err instanceof SpecNotFoundError || err instanceof ProjectNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  logger.error({ err }, `${operation} failed`);
  res.status(500).json({ success: false, error: 'internal server error' });
}

export async function getSpecPendingSummaryHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    badRequest(res, 'invalid spec id');
    return;
  }
  try {
    const summary = await getSpecPendingSummary(specId.data);
    res.status(200).json({ success: true, data: summary });
  } catch (err) {
    mapError(err, res, 'get spec pending summary');
  }
}

const PackageIdSchema = z.uuid().optional();

export async function getProjectPendingSummaryHandler(req: Request, res: Response): Promise<void> {
  const projectId = z.uuid().safeParse(req.params['id']);
  const packageId = PackageIdSchema.safeParse(req.query['packageId']);
  if (!projectId.success || !packageId.success) {
    badRequest(res, 'invalid project pending-summary request');
    return;
  }
  try {
    const summary = await getProjectPendingSummary(projectId.data, packageId.data);
    res.status(200).json({ success: true, data: summary });
  } catch (err) {
    mapError(err, res, 'get project pending summary');
  }
}
