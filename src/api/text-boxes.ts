import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import {
  getTextBoxesReport,
  ProjectNotFoundError,
  SpecNotFoundError,
  type TextBoxScope,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

function mapError(err: unknown, res: Response): void {
  if (err instanceof SpecNotFoundError || err instanceof ProjectNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  logger.error({ err }, 'text-boxes report failed');
  res.status(500).json({ success: false, error: 'text-boxes report failed' });
}

async function handle(scope: TextBoxScope, res: Response): Promise<void> {
  try {
    const report = await getTextBoxesReport(scope);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    mapError(err, res);
  }
}

export async function getSpecTextBoxesHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  await handle({ kind: 'spec', specId: id.data }, res);
}

export async function getProjectTextBoxesHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  await handle({ kind: 'project', projectId: id.data }, res);
}

export function registerTextBoxRoutes(router: Router): void {
  router.get('/specs/:id/text-boxes', getSpecTextBoxesHandler);
  router.get('/projects/:id/text-boxes', getProjectTextBoxesHandler);
}
