import type { Request, Response } from 'express';
import { z } from 'zod';
import { CreateAssociationBodySchema } from '../ast/index.js';
import {
  createAssociation,
  listAssociationsForParagraph,
  deleteAssociation,
  getParagraphSpecId,
  AssociationParagraphNotFoundError,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

interface Ids {
  readonly specId: string;
  readonly nodeId: string;
}

/** Validate path ids and assert the paragraph belongs to the spec. Returns the
 *  ids on success, or null after writing the appropriate 400/404 response. */
async function resolveIds(req: Request, res: Response): Promise<Ids | null> {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return null;
  }
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  if (!nodeId.success) {
    res.status(400).json({ success: false, error: 'invalid node id' });
    return null;
  }
  const specOfNode = await getParagraphSpecId(nodeId.data);
  // Case-insensitive: getParagraphSpecId returns the canonical (lowercase) spec_id
  // while specId.data is an unnormalized route param — match the MCP path so a valid
  // uppercase spec id is not a false 404 (CodeRabbit).
  if (!specOfNode || specOfNode.toLowerCase() !== specId.data.toLowerCase()) {
    res.status(404).json({ success: false, error: 'paragraph not found in spec' });
    return null;
  }
  return { specId: specId.data, nodeId: nodeId.data };
}

export async function createAssociationHandler(req: Request, res: Response): Promise<void> {
  const ids = await resolveIds(req, res);
  if (!ids) return;
  const body = CreateAssociationBodySchema.safeParse(req.body);
  if (!body.success) {
    res
      .status(400)
      .json({ success: false, error: body.error.issues[0]?.message ?? 'invalid body' });
    return;
  }
  try {
    const created = await createAssociation(ids.nodeId, body.data);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    if (err instanceof AssociationParagraphNotFoundError) {
      res.status(404).json({ success: false, error: 'paragraph not found' });
      return;
    }
    logger.error({ err }, 'create association failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function listAssociationsHandler(req: Request, res: Response): Promise<void> {
  const ids = await resolveIds(req, res);
  if (!ids) return;
  try {
    const data = await listAssociationsForParagraph(ids.nodeId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error({ err }, 'list associations failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function deleteAssociationHandler(req: Request, res: Response): Promise<void> {
  const ids = await resolveIds(req, res);
  if (!ids) return;
  const associationId = z.uuid().safeParse(req.params['associationId']);
  if (!associationId.success) {
    res.status(400).json({ success: false, error: 'invalid association id' });
    return;
  }
  try {
    const deleted = await deleteAssociation(ids.nodeId, associationId.data);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'association not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'delete association failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
