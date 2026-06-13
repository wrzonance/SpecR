import type { Request, Response } from 'express';
import {
  createProject,
  setProjectSources,
  findProjectById,
  addSectionToProject,
  removeSectionFromProject,
  getBrokenRefs,
  InvalidSourceLibraryError,
  ProjectNotFoundError,
  SectionUnresolvedError,
  pool,
} from '../db/index.js';
import type {
  CreateProjectBody,
  SetProjectSourcesBody,
  AddSectionToProjectBody,
} from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

export async function createProjectHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as CreateProjectBody;
    const project = await createProject(body, pool);
    res.status(201).json({ success: true, data: project });
  } catch (err) {
    if (err instanceof InvalidSourceLibraryError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
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

export async function setProjectSourcesHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const body = req.body as SetProjectSourcesBody;
    const sources = await setProjectSources(id, body.sourceLibraryIds, pool);
    if (!sources) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: { projectId: id, sources } });
  } catch (err) {
    if (err instanceof InvalidSourceLibraryError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'set project sources failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function addSectionToProjectHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const body = req.body as AddSectionToProjectBody;
    const result = await addSectionToProject(id, body.section, pool);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    if (err instanceof SectionUnresolvedError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    const mapped = pgErrorToHttp(err, { '23505': 'section already in project' });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'add section to project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function removeSectionFromProjectHandler(req: Request, res: Response): Promise<void> {
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
  const force = req.query['force'] === 'true';
  try {
    const outcome = await removeSectionFromProject(projectId, specId, force, pool);
    if (outcome === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not in project' });
      return;
    }
    if (outcome === 'edited') {
      res.status(409).json({
        success: false,
        error: 'section has project edits — repeat with ?force=true to delete them',
      });
      return;
    }
    if (outcome === 'in-package') {
      res.status(409).json({
        success: false,
        error: 'section belongs to a design package — remove it from the package first',
      });
      return;
    }
    res.status(200).json({ success: true, data: { projectId, specId } });
  } catch (err) {
    logger.error({ err }, 'remove section from project failed');
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
