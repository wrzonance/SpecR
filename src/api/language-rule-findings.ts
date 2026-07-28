import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getLanguageFindingsReport,
  ProjectNotFoundError,
  PackageNotFoundError,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

// #411 / ADR-080 — mirrors src/api/coordination.ts's project + optional
// ?packageId= scope pattern. `configured: false` (opt-in linting, off for
// every present spec) is a normal 200 body, never a 404/500 — only an
// unresolvable project/package id is an error.

function mapError(err: unknown, res: Response): void {
  if (err instanceof ProjectNotFoundError || err instanceof PackageNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  logger.error({ err }, 'get language findings report failed');
  res.status(500).json({ success: false, error: 'internal server error' });
}

export async function getLanguageFindingsHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  let packageId: string | undefined;
  const rawPackageId = req.query['packageId'];
  if (rawPackageId !== undefined) {
    const pkg = z.uuid().safeParse(rawPackageId);
    if (!pkg.success) {
      res.status(400).json({ success: false, error: 'invalid package id' });
      return;
    }
    packageId = pkg.data;
  }
  try {
    const report = await getLanguageFindingsReport(id.data, packageId);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    mapError(err, res);
  }
}
