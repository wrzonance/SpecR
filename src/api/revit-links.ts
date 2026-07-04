import type { Request, Response } from 'express';
import { z } from 'zod';
import { getProjectRevitLinks, ProjectNotFoundError, type RevitLinkFilter } from '../db/index.js';

function mapError(err: unknown, res: Response): void {
  if (err instanceof ProjectNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'revit link inventory failed' });
}

// Returns null and writes a 400 when a filter param is malformed.
function parseFilter(req: Request, res: Response): RevitLinkFilter | null {
  const filter: { revitInstanceId?: string; specId?: string } = {};
  const rawInstance = req.query['revitInstanceId'];
  if (typeof rawInstance === 'string' && rawInstance.length > 0) {
    filter.revitInstanceId = rawInstance;
  }
  const rawSpecId = req.query['specId'];
  if (rawSpecId !== undefined) {
    const specId = z.uuid().safeParse(rawSpecId);
    if (!specId.success) {
      res.status(400).json({ success: false, error: 'invalid spec id' });
      return null;
    }
    filter.specId = specId.data;
  }
  return filter;
}

export async function getProjectRevitLinksHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  const filter = parseFilter(req, res);
  if (filter === null) return;
  try {
    const inventory = await getProjectRevitLinks(id.data, filter);
    res.status(200).json({ success: true, data: inventory });
  } catch (err) {
    mapError(err, res);
  }
}
