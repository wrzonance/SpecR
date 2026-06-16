import type { Request, Response } from 'express';
import { z } from 'zod';
import { findSpecById, pool } from '../db/index.js';
import { applyAccepted, InvalidAcceptedChangeError, MergeError } from '../merge/index.js';
import { logger } from '../lib/logger.js';

const ParagraphDiffSchema = z.object({
  uuid: z.uuid(),
  text: z.string(),
  index: z.number().int().min(0),
});

const ModifiedDiffSchema = z.object({
  uuid: z.uuid(),
  base: z.string(),
  theirs: z.string(),
  ours: z.string(),
});

const DiffResultSchema = z.object({
  added: z.array(ParagraphDiffSchema),
  modified: z.array(ModifiedDiffSchema),
  deleted: z.array(z.uuid()),
  conflicts: z.array(ModifiedDiffSchema),
  warnings: z.array(z.string()),
});

const MergeBodySchema = z.strictObject({
  accept: z.array(z.uuid()),
  diff: DiffResultSchema,
});

async function rollback(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* best-effort */
  }
}

export async function mergeHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const bodyResult = MergeBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid merge request body' });
    return;
  }
  const client = await pool.connect();
  try {
    const spec = await findSpecById(idResult.data);
    if (!spec) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    await client.query('BEGIN');
    const result = await applyAccepted(
      idResult.data,
      bodyResult.data.accept,
      bodyResult.data.diff,
      client
    );
    await client.query('COMMIT');
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    await rollback(client);
    if (err instanceof InvalidAcceptedChangeError) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    if (err instanceof MergeError) {
      res.status(409).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'merge failed');
    res.status(500).json({ success: false, error: 'merge failed' });
  } finally {
    client.release();
  }
}
