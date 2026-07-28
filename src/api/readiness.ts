import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getReadinessReport,
  SpecNotFoundError,
  PackageNotFoundError,
  type ReadinessScope,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

// REST dry-run surface for the ADR-079 issuance-readiness gate (#406):
// GET /specs/:id/readiness-report and GET /packages/:id/readiness-report
// mirror open-comments.ts's shape exactly (same param validation, same
// SpecNotFoundError/PackageNotFoundError -> 404 mapping) — a specifier can
// resolve blockers before attempting a Final issuance instead of discovering
// them from the gate's own 422.

function mapError(err: unknown, res: Response): void {
  if (err instanceof SpecNotFoundError || err instanceof PackageNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  logger.error({ err }, 'readiness report failed');
  res.status(500).json({ success: false, error: 'readiness report failed' });
}

async function handle(scope: ReadinessScope, res: Response): Promise<void> {
  try {
    const report = await getReadinessReport(scope);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    mapError(err, res);
  }
}

export async function getSpecReadinessHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  await handle({ kind: 'spec', specId: id.data }, res);
}

export async function getPackageReadinessHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid package id' });
    return;
  }
  await handle({ kind: 'package', packageId: id.data }, res);
}
