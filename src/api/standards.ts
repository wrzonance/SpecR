import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getStandardsRollup,
  recordStandardVerification,
  ProjectNotFoundError,
  LibraryNotFoundError,
  type StandardsScope,
  type RecordVerificationInput,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

const UUID = z.uuid();

const VerificationBodySchema = z.object({
  status: z.enum(['current', 'superseded', 'withdrawn', 'unknown']).optional(),
  currentVersion: z.string().trim().min(1).max(200).nullish(),
  sourceUrl: z.url().max(2000).nullish(),
  title: z.string().trim().min(1).max(500).nullish(),
  notes: z.string().max(5000).nullish(),
});

async function respondRollup(
  req: Request,
  res: Response,
  kind: StandardsScope['kind']
): Promise<void> {
  const id = UUID.safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: `invalid ${kind} id` });
    return;
  }
  try {
    const rollup = await getStandardsRollup({ kind, id: id.data });
    res.status(200).json({ success: true, data: rollup });
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) {
      res.status(404).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'standards rollup failed');
    res.status(500).json({ success: false, error: 'standards rollup failed' });
  }
}

export async function getProjectStandardsHandler(req: Request, res: Response): Promise<void> {
  await respondRollup(req, res, 'project');
}

export async function getLibraryStandardsHandler(req: Request, res: Response): Promise<void> {
  await respondRollup(req, res, 'library');
}

function parseKey(req: Request): { orgCode: string; standardCode: string } | null {
  const orgCode = req.params['orgCode'];
  const standardCode = req.params['standardCode'];
  if (typeof orgCode !== 'string' || typeof standardCode !== 'string') return null;
  if (orgCode.trim() === '' || standardCode.trim() === '') return null;
  return { orgCode, standardCode };
}

export async function recordStandardVerificationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const key = parseKey(req);
  if (key === null) {
    res.status(400).json({ success: false, error: 'orgCode and standardCode are required' });
    return;
  }
  // Body is optional (OpenAPI requestBody.required=false, ADR-064 §3): a no-body
  // PUT leaves req.body undefined when no application/json header is sent — treat
  // it as an empty verdict ({} → all fields reset, status defaults to 'unknown').
  const body = VerificationBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(422).json({ success: false, error: 'validation failed' });
    return;
  }
  const input: RecordVerificationInput = { ...key, ...body.data };
  try {
    const record = await recordStandardVerification(input);
    res.status(200).json({ success: true, data: record });
  } catch (err) {
    logger.error({ err }, 'record standard verification failed');
    res.status(500).json({ success: false, error: 'record standard verification failed' });
  }
}
