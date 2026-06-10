import type { Request, Response } from 'express';
import { z } from 'zod';
import { getSpecTree, updateSpec, getSpecLineage, listSpecs, deleteSpec } from '../db/index.js';
import { getPgCode } from './pg-error.js';
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

// DELETE /specs/:id — hard-deletes a spec and everything it owns (paragraphs,
// references, versions). Inbound references from other specs are nulled by the
// schema (SET NULL). 409 if the spec is still pinned to a project (RESTRICT).
export async function deleteSpecHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  try {
    const removed = await deleteSpec(id);
    if (!removed) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: { specId: id } });
  } catch (err) {
    if (getPgCode(err) === '23503') {
      res.status(409).json({
        success: false,
        error: 'spec is still a member of a project — remove it from all projects first',
      });
      return;
    }
    logger.error({ err }, 'delete spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
