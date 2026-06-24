import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getOpenCommentsReport,
  SpecNotFoundError,
  ProjectNotFoundError,
  type OpenCommentsScope,
} from '../db/index.js';

function mapError(err: unknown, res: Response): void {
  if (err instanceof SpecNotFoundError || err instanceof ProjectNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'open-comments report failed' });
}

async function handle(scope: OpenCommentsScope, res: Response): Promise<void> {
  try {
    const report = await getOpenCommentsReport(scope);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    mapError(err, res);
  }
}

export async function getSpecOpenCommentsHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  await handle({ kind: 'spec', specId: id.data }, res);
}

export async function getProjectOpenCommentsHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  await handle({ kind: 'project', projectId: id.data }, res);
}
