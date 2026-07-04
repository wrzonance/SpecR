import type { Request, Response } from 'express';
import { z } from 'zod';
import { getProjectRevitLinks, ProjectNotFoundError, type RevitLinkFilter } from '../db/index.js';

// Validate the filter query params at the boundary. Both are single-value and
// optional; a present-but-malformed value (empty string, a repeated param that
// Express surfaces as an array, or a non-uuid specId) is a 400 — matching the
// openapi.yaml schema (revitInstanceId minLength:1, specId uuid) and the MCP
// list_revit_links tool schema, rather than silently returning the full inventory.
const FilterQuerySchema = z.object({
  revitInstanceId: z.string().min(1).optional(),
  specId: z.uuid().optional(),
});

function mapError(err: unknown, res: Response): void {
  if (err instanceof ProjectNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'revit link inventory failed' });
}

// Returns null and writes a 400 when a filter param is malformed.
function parseFilter(req: Request, res: Response): RevitLinkFilter | null {
  const parsed = FilterQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid revit-links filter query' });
    return null;
  }
  const filter: { revitInstanceId?: string; specId?: string } = {};
  if (parsed.data.revitInstanceId !== undefined)
    filter.revitInstanceId = parsed.data.revitInstanceId;
  if (parsed.data.specId !== undefined) filter.specId = parsed.data.specId;
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
