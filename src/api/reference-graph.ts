import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getReferenceGraph,
  ProjectNotFoundError,
  LibraryNotFoundError,
  type GraphScope,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

const UUID = z.uuid();

async function respond(req: Request, res: Response, kind: GraphScope['kind']): Promise<void> {
  const id = UUID.safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: `invalid ${kind} id` });
    return;
  }
  const includeAnchors = req.query['includeAnchors'] === 'true';
  try {
    const graph = await getReferenceGraph({ kind, id: id.data }, { includeAnchors });
    res.status(200).json({ success: true, data: graph });
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) {
      res.status(404).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'reference graph failed');
    res.status(500).json({ success: false, error: 'reference graph failed' });
  }
}

export async function getProjectReferenceGraphHandler(req: Request, res: Response): Promise<void> {
  await respond(req, res, 'project');
}

export async function getLibraryReferenceGraphHandler(req: Request, res: Response): Promise<void> {
  await respond(req, res, 'library');
}
