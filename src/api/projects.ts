import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  createProject,
  findProjectById,
  listProjects,
  listProjectSpecs,
  setProjectSources,
  updateProject,
  softDeleteProject,
  restoreProject,
  addSectionToProject,
  removeSectionFromProject,
  getBrokenRefs,
  InvalidSourceLibraryError,
  ProjectNotFoundError,
  SectionUnresolvedError,
  ClientNotFoundError,
  pool,
} from '../db/index.js';
import { SetProjectSourcesBodySchema } from '../ast/index.js';
import type { CreateProjectBody, AddSectionToProjectBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';
import { SectionNumberFormatSchema } from '../lib/section-number.js';

const PatchProjectBody = z
  .object({
    name: z.string().check(z.minLength(1)).optional(),
    sectionNumberFormat: SectionNumberFormatSchema.optional(),
    // Absent = leave association unchanged; null = disassociate; uuid = associate (ADR-054).
    clientId: z.uuid().nullable().optional(),
  })
  .check((ctx) => {
    if (
      ctx.value.name === undefined &&
      ctx.value.sectionNumberFormat === undefined &&
      ctx.value.clientId === undefined
    ) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'at least one of name, sectionNumberFormat, or clientId is required',
      });
    }
  });

// Soft-delete audit (ADR-031): the actor is caller-supplied free text — there is
// no user/auth model yet (#43). When auth lands this is populated from the session.
const DeleteProjectBody = z.object({ deletedBy: z.string().check(z.minLength(1)) });

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

export async function listProjectsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const projects = await listProjects(pool);
    res.status(200).json({ success: true, data: projects });
  } catch (err) {
    logger.error({ err }, 'list projects failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function setProjectSourcesHandler(req: Request, res: Response): Promise<void> {
  const parsedId = z.uuid().safeParse(req.params['id']);
  if (!parsedId.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  const id = parsedId.data;
  const parsed = SetProjectSourcesBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: 'sourceLibraryIds must be a non-empty array of unique UUIDs',
    });
    return;
  }
  try {
    const project = await findProjectById(id, pool);
    if (!project) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    const sources = await setProjectSources(id, parsed.data.sourceLibraryIds, pool);
    res.status(200).json({ success: true, data: { projectId: id, sources } });
  } catch (err) {
    if (err instanceof InvalidSourceLibraryError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    const mapped = pgErrorToHttp(err);
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'set project sources failed');
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

/**
 * GET /projects/{id}/specs — list a project's specs, each with its resolved discipline
 * (ADR-065, built-in default mapping). Optional `discipline` query param filters by key.
 */
export async function listProjectSpecsHandler(req: Request, res: Response): Promise<void> {
  const parsedId = z.uuid().safeParse(req.params['id']);
  if (!parsedId.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  const parsedDiscipline = z.string().optional().safeParse(req.query['discipline']);
  if (!parsedDiscipline.success) {
    res.status(400).json({ success: false, error: 'discipline filter must be a single value' });
    return;
  }
  const discipline = parsedDiscipline.data;
  try {
    const project = await findProjectById(parsedId.data, pool);
    if (!project) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    const specs = await listProjectSpecs(
      parsedId.data,
      discipline !== undefined ? { discipline } : {},
      pool
    );
    res.status(200).json({ success: true, data: specs });
  } catch (err) {
    logger.error({ err }, 'list project specs failed');
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

export async function patchProjectHandler(req: Request, res: Response): Promise<void> {
  const parsedId = z.uuid().safeParse(req.params['id']);
  if (!parsedId.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  const id = parsedId.data;
  const parsed = PatchProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: 'at least one of name, sectionNumberFormat, or clientId is required',
    });
    return;
  }
  try {
    const patch = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.sectionNumberFormat !== undefined
        ? { sectionNumberFormat: parsed.data.sectionNumberFormat }
        : {}),
      ...(parsed.data.clientId !== undefined ? { clientId: parsed.data.clientId } : {}),
    };
    const updated = await updateProject(id, patch, pool);
    if (!updated) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({
      success: true,
      data: {
        projectId: updated.id,
        name: updated.name,
        sectionNumberFormat: updated.sectionNumberFormat,
        clientId: updated.clientId,
      },
    });
  } catch (err) {
    // Unknown client on association → 422 (FK-validation convention, ADR-054).
    if (err instanceof ClientNotFoundError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'patch project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function deleteProjectHandler(req: Request, res: Response): Promise<void> {
  const parsedId = z.uuid().safeParse(req.params['id']);
  if (!parsedId.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  const parsed = DeleteProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'deletedBy is required' });
    return;
  }
  try {
    // Idempotent: re-deleting returns the EXISTING tombstone (ADR-031), so the
    // original who/when is never clobbered by a later delete.
    const tombstone = await softDeleteProject(parsedId.data, parsed.data.deletedBy, pool);
    if (!tombstone) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: tombstone });
  } catch (err) {
    logger.error({ err }, 'delete project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function restoreProjectHandler(req: Request, res: Response): Promise<void> {
  const parsedId = z.uuid().safeParse(req.params['id']);
  if (!parsedId.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  try {
    // Idempotent: restoring a non-deleted project is a 200 no-op (ADR-031).
    const restored = await restoreProject(parsedId.data, pool);
    if (!restored) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: restored });
  } catch (err) {
    logger.error({ err }, 'restore project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
