import { z } from 'zod';
import type { Request, Response } from 'express';
import { searchParagraphs, toSearchOptions } from '../db/index.js';
import { NodeTypeSchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';

// Query-string params arrive as strings, so numeric filters coerce. `q` is the
// only required field; everything else scopes the ranked full-text search (ADR-062).
const SearchQuerySchema = z.object({
  q: z.string().check(z.minLength(1)),
  libraryId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  division: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
  part: z.coerce.number().int().min(1).max(3).optional(),
  nodeType: NodeTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function searchHandler(req: Request, res: Response): Promise<void> {
  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid search query' });
    return;
  }
  const { q, ...filters } = parsed.data;
  try {
    const results = await searchParagraphs(q, toSearchOptions(filters));
    res.status(200).json({ success: true, data: results });
  } catch (err) {
    logger.error({ err }, 'search failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
