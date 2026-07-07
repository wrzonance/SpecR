import type { Request, Response } from 'express';
import {
  buildComparisonReport,
  ReportingError,
  SpecNotFoundError,
  type CompareRequest,
} from '../reporting/index.js';
import { logger } from '../lib/logger.js';

function mapError(err: unknown, res: Response): void {
  if (err instanceof SpecNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof ReportingError) {
    res.status(422).json({ success: false, error: err.message });
    return;
  }
  // This handler catches everything, so an unexpected failure never reaches the
  // errorHandler middleware — log it here or it is invisible in production.
  logger.error({ err }, 'compare report failed');
  res.status(500).json({ success: false, error: 'compare report failed' });
}

/** POST /reports/compare — body already validated by validateBody(CompareRequestSchema),
 *  which applies the alignment/include defaults. */
export async function compareReportHandler(req: Request, res: Response): Promise<void> {
  const { sources, baseline, alignment, include } = req.body as CompareRequest;
  try {
    const report = await buildComparisonReport(sources, {
      ...(baseline !== undefined ? { baseline } : {}),
      alignment,
      include,
    });
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    mapError(err, res);
  }
}
