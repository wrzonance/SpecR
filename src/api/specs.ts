import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getSpecTree,
  updateSpec,
  getSpecLineage,
  getSpecStyleSource,
  getOnboardingStatus,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

export async function getSpecHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  try {
    const result = await getSpecTree(id);
    if (!result) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    // Merge the style-source association in as a sibling field (#138). A separate
    // query keeps getSpecTree untouched (owned by a parallel PR); styleSource is
    // { templateId, templateName } | null. onboardingStatus (#139) is surfaced the
    // same way: 'review' | 'active'.
    const styleSource = await getSpecStyleSource(id);
    const onboardingStatus = await getOnboardingStatus(id);
    res
      .status(200)
      .json({ success: true, data: { ...result.tree, styleSource, onboardingStatus } });
  } catch (err) {
    logger.error({ err }, 'get spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getSpecLineageHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    const lineage = await getSpecLineage(idResult.data);
    if (!lineage) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: lineage });
  } catch (err) {
    logger.error({ err }, 'get spec lineage failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function updateSpecHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  try {
    const body = req.body as { readonly title?: string; readonly section?: string };
    const spec = await updateSpec(id, body);
    if (!spec) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: spec });
  } catch (err) {
    logger.error({ err }, 'update spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
