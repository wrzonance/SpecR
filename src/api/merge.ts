import type { Request, Response } from 'express';
import { z } from 'zod';
import { findSpecById, pool, assertSpecWritable } from '../db/index.js';
import { applyAccepted, InvalidAcceptedChangeError, MergeError } from '../merge/index.js';
import { gateErrorResponse } from './edit-gate-response.js';
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
  // Optimistic-concurrency precondition (ADR-018 D1): the spec content_version
  // the redline was diffed against. Optional; stale → 409 with current version.
  expectedVersion: z.number().int().min(1).optional(),
});

async function rollback(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* best-effort */
  }
}

/** Map a merge-path error to its HTTP response, or null to fall through to the
 *  500 path. Edit-gate errors (ADR-018) first, then merge-specific errors. */
function mergeErrorResponse(
  err: unknown
): { readonly status: number; readonly body: Record<string, unknown> } | null {
  const gate = gateErrorResponse(err);
  if (gate) return gate;
  if (err instanceof InvalidAcceptedChangeError) {
    return { status: 400, body: { success: false, error: err.message } };
  }
  if (err instanceof MergeError) {
    return { status: 409, body: { success: false, error: err.message } };
  }
  return null;
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
    // Composed edit gate + optimistic precondition before applying the redline:
    // a merge mutates content, so it is governed exactly like a paragraph write.
    await assertSpecWritable(client, idResult.data, bodyResult.data.expectedVersion);
    const result = await applyAccepted(
      idResult.data,
      bodyResult.data.accept,
      bodyResult.data.diff,
      client
    );
    await client.query(
      `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
      [idResult.data]
    );
    await client.query('COMMIT');
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    await rollback(client);
    const mapped = mergeErrorResponse(err);
    if (mapped) {
      res.status(mapped.status).json(mapped.body);
      return;
    }
    logger.error({ err }, 'merge failed');
    res.status(500).json({ success: false, error: 'merge failed' });
  } finally {
    client.release();
  }
}
