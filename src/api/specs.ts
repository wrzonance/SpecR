import type { Request, Response } from 'express';
import { z } from 'zod';
import { getSpecTree, updateSpec, getSpecLineage, listSpecs } from '../db/index.js';
import { logger } from '../lib/logger.js';

export async function listSpecsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const specs = await listSpecs();
    res.status(200).json({ success: true, data: specs });
  } catch (err) {
    logger.error({ err }, 'list specs failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getSpecTreeHandler(req: Request, res: Response): Promise<void> {
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
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, 'get spec tree failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

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
    res.status(200).json({ success: true, data: result.tree });
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
