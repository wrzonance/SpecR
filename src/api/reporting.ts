import type { Request, Response } from 'express';
import {
  buildComparisonReport,
  ReportingError,
  SpecNotFoundError,
  type CompareRequest,
} from '../reporting/index.js';

function mapError(err: unknown, res: Response): void {
  if (err instanceof SpecNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof ReportingError) {
    res.status(422).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'compare report failed' });
}

/** POST /reports/compare — body already validated by validateBody(CompareRequestSchema). */
export async function compareReportHandler(req: Request, res: Response): Promise<void> {
  const { sources, baseline } = req.body as CompareRequest;
  try {
    const report = await buildComparisonReport(sources, baseline !== undefined ? { baseline } : {});
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    mapError(err, res);
  }
}
