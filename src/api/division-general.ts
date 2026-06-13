import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getLibraryDivisionGeneralSpec,
  getProjectDivisionGeneralSpec,
  setLibraryDivisionGeneralSpec,
  setProjectDivisionGeneralSpec,
  DivisionGeneralOwnerNotFoundError,
  DivisionGeneralSpecNotInScopeError,
  pool,
} from '../db/index.js';
import type { SetDivisionGeneralSpecBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';

const DivisionSchema = z.string().regex(/^\d{2}$/);

type Scope = 'library' | 'project';

interface ParsedParams {
  readonly ownerId: string;
  readonly division: string;
}

function parseParams(req: Request, ownerName: string, res: Response): ParsedParams | null {
  const ownerResult = z.uuid().safeParse(req.params[ownerName]);
  if (!ownerResult.success) {
    res.status(400).json({ success: false, error: `invalid ${ownerName}` });
    return null;
  }
  const divisionResult = DivisionSchema.safeParse(req.params['division']);
  if (!divisionResult.success) {
    res.status(400).json({ success: false, error: 'invalid division' });
    return null;
  }
  return { ownerId: ownerResult.data, division: divisionResult.data };
}

async function getDivisionGeneralSpec(req: Request, res: Response, scope: Scope): Promise<void> {
  const ownerName = scope === 'library' ? 'libraryId' : 'projectId';
  const params = parseParams(req, ownerName, res);
  if (!params) return;
  try {
    const data =
      scope === 'library'
        ? await getLibraryDivisionGeneralSpec(params.ownerId, params.division, pool)
        : await getProjectDivisionGeneralSpec(params.ownerId, params.division, pool);
    if (!data) {
      res.status(404).json({ success: false, error: `${scope} not found` });
      return;
    }
    res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error({ err, scope }, 'get division general spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

async function setDivisionGeneralSpec(req: Request, res: Response, scope: Scope): Promise<void> {
  const ownerName = scope === 'library' ? 'libraryId' : 'projectId';
  const params = parseParams(req, ownerName, res);
  if (!params) return;
  try {
    const body = req.body as SetDivisionGeneralSpecBody;
    const data =
      scope === 'library'
        ? await setLibraryDivisionGeneralSpec(params.ownerId, params.division, body, pool)
        : await setProjectDivisionGeneralSpec(params.ownerId, params.division, body, pool);
    res.status(200).json({ success: true, data });
  } catch (err) {
    if (err instanceof DivisionGeneralOwnerNotFoundError) {
      res.status(404).json({ success: false, error: `${scope} not found` });
      return;
    }
    if (err instanceof DivisionGeneralSpecNotInScopeError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err, scope }, 'set division general spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getLibraryDivisionGeneralSpecHandler(
  req: Request,
  res: Response
): Promise<void> {
  await getDivisionGeneralSpec(req, res, 'library');
}

export async function setLibraryDivisionGeneralSpecHandler(
  req: Request,
  res: Response
): Promise<void> {
  await setDivisionGeneralSpec(req, res, 'library');
}

export async function getProjectDivisionGeneralSpecHandler(
  req: Request,
  res: Response
): Promise<void> {
  await getDivisionGeneralSpec(req, res, 'project');
}

export async function setProjectDivisionGeneralSpecHandler(
  req: Request,
  res: Response
): Promise<void> {
  await setDivisionGeneralSpec(req, res, 'project');
}
