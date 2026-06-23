import type { Request, Response } from 'express';
import { z } from 'zod';
import { getCoordinationReport, ProjectNotFoundError, PackageNotFoundError } from '../db/index.js';

function mapError(err: unknown, res: Response): void {
  if (err instanceof ProjectNotFoundError || err instanceof PackageNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'coordination report failed' });
}

export async function getCoordinationReportHandler(req: Request, res: Response): Promise<void> {
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
    const report = await getCoordinationReport(id.data, packageId);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    mapError(err, res);
  }
}
