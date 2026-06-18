import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  deleteProjectRevisionNomenclature,
  findProjectById,
  findRevisionNomenclatureProfileById,
  getRevisionNomenclatureForProject,
  listRevisionNomenclatureProfiles,
  pool,
  upsertProjectRevisionNomenclature,
} from '../db/index.js';
import type { PutRevisionNomenclatureBody, CloneRevisionNomenclatureBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';

const UUID_SCHEMA = z.uuid();

function parseProjectId(req: Request, res: Response): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return null;
  }
  return result.data;
}

async function requireProject(projectId: string, res: Response): Promise<boolean> {
  const project = await findProjectById(projectId, pool);
  if (!project) {
    res.status(404).json({ success: false, error: 'project not found' });
    return false;
  }
  return true;
}

export async function listRevisionNomenclatureProfilesHandler(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const profiles = await listRevisionNomenclatureProfiles(pool);
    res.status(200).json({ success: true, data: profiles });
  } catch (err) {
    logger.error({ err }, 'list revision nomenclature profiles failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getProjectRevisionNomenclatureHandler(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  try {
    if (!(await requireProject(projectId, res))) return;
    const profile = await getRevisionNomenclatureForProject(projectId, pool);
    if (!profile) {
      res.status(404).json({ success: false, error: 'no revision nomenclature available' });
      return;
    }
    res.status(200).json({
      success: true,
      data: profile,
      meta: { inherited: profile.projectId === null },
    });
  } catch (err) {
    logger.error({ err }, 'get project revision nomenclature failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function putProjectRevisionNomenclatureHandler(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  const body = req.body as PutRevisionNomenclatureBody;
  try {
    if (!(await requireProject(projectId, res))) return;
    const profile = await upsertProjectRevisionNomenclature(projectId, body.name, body.types, pool);
    res.status(200).json({ success: true, data: profile });
  } catch (err) {
    logger.error({ err }, 'put project revision nomenclature failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function cloneProjectRevisionNomenclatureHandler(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  const body = req.body as CloneRevisionNomenclatureBody;
  try {
    if (!(await requireProject(projectId, res))) return;
    const source = await findRevisionNomenclatureProfileById(body.sourceId, pool);
    if (!source) {
      res.status(404).json({ success: false, error: 'source revision nomenclature not found' });
      return;
    }
    const profile = await upsertProjectRevisionNomenclature(
      projectId,
      source.name,
      source.types,
      pool
    );
    res.status(201).json({ success: true, data: profile });
  } catch (err) {
    logger.error({ err }, 'clone project revision nomenclature failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function deleteProjectRevisionNomenclatureHandler(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  try {
    if (!(await requireProject(projectId, res))) return;
    await deleteProjectRevisionNomenclature(projectId, pool);
    res.status(200).json({ success: true, data: { projectId } });
  } catch (err) {
    logger.error({ err }, 'delete project revision nomenclature failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
