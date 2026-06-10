import type { Request, Response } from 'express';
import {
  createProject,
  findProjectById,
  addSpecToProject,
  removeSpecFromProject,
  getBrokenRefs,
  pool,
} from '../db/index.js';
import type { CreateProjectBody, AddSpecToProjectBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { getPgCode } from '../lib/pg-errors.js';

export async function createProjectHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as CreateProjectBody;
    const project = await createProject(body, pool);
    res.status(201).json({ success: true, data: project });
  } catch (err) {
    logger.error({ err }, 'create project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getProjectHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const project = await findProjectById(id, pool);
    if (!project) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: project });
  } catch (err) {
    logger.error({ err }, 'get project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function addSpecToProjectHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const body = req.body as AddSpecToProjectBody;
    const result = await addSpecToProject(id, body.specId, pool);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    const pgCode = getPgCode(err);
    if (pgCode === '23503') {
      res.status(404).json({ success: false, error: 'project or spec not found' });
      return;
    }
    if (pgCode === '23505') {
      res.status(409).json({ success: false, error: 'spec already in project' });
      return;
    }
    logger.error({ err }, 'add spec to project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function removeSpecFromProjectHandler(req: Request, res: Response): Promise<void> {
  const projectId = req.params['id'];
  const specId = req.params['specId'];
  if (!projectId || typeof projectId !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  if (!specId || typeof specId !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  try {
    const removed = await removeSpecFromProject(projectId, specId, pool);
    if (!removed) {
      res.status(404).json({ success: false, error: 'spec not in project' });
      return;
    }
    res.status(200).json({ success: true, data: { projectId, specId } });
  } catch (err) {
    logger.error({ err }, 'remove spec from project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getBrokenRefsHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const refs = await getBrokenRefs(id, pool);
    res.status(200).json({ success: true, data: refs });
  } catch (err) {
    logger.error({ err }, 'get broken refs failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
