import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createCheckpointForActor,
  listCheckpoints,
  getCheckpointById,
  CheckpointScopeNotFoundError,
} from '../db/index.js';
import type { CheckpointScope } from '../db/index.js';
import { CreateCheckpointBodySchema } from '../ast/index.js';
import type { CreateCheckpointBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';

// ADR-052 D3/D4/D9 (issue #380, task 9) — checkpoints REST surface: stored
// named markers sealing a spec (scope: 'spec') or every spec in a project
// (scope: 'project') at their current content_version(s). Scope is encoded by
// which parent path a request hits (`/specs/{id}/checkpoints` vs.
// `/projects/{id}/checkpoints}`), mirroring open-comments.ts's spec/project
// pair — never a body field, so the path segment and the sealed scope can
// never disagree.

function badRequest(res: Response, error: string): void {
  res.status(400).json({ success: false, error });
}

function internalError(res: Response, err: unknown, operation: string): void {
  logger.error({ err }, `${operation} failed`);
  res.status(500).json({ success: false, error: 'internal server error' });
}

function parseScopeId(req: Request, res: Response, label: string): string | null {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    badRequest(res, `invalid ${label} id`);
    return null;
  }
  return id.data;
}

function parseCreateBody(req: Request, res: Response): CreateCheckpointBody | null {
  const body = CreateCheckpointBodySchema.safeParse(req.body);
  if (!body.success) {
    badRequest(res, 'name (non-empty) and actorLabel (1-200 characters) are required');
    return null;
  }
  return body.data;
}

/** Resolves actorLabel to a real users.id (checkpoints.user_id is NOT NULL,
 *  ADR-052 D6) then seals the checkpoint. Shared by the spec- and
 *  project-scoped create handlers — only `scope`/`scopeId` differ between them. */
async function createCheckpointForScope(
  scope: CheckpointScope,
  scopeId: string,
  body: CreateCheckpointBody,
  res: Response
): Promise<void> {
  try {
    const checkpoint = await createCheckpointForActor({
      name: body.name,
      scope,
      scopeId,
      actorLabel: body.actorLabel,
    });
    res.status(201).json({ success: true, data: checkpoint });
  } catch (err) {
    if (err instanceof CheckpointScopeNotFoundError) {
      res.status(404).json({ success: false, error: err.message });
      return;
    }
    internalError(res, err, 'create checkpoint');
  }
}

async function listCheckpointsForScope(
  scope: CheckpointScope,
  scopeId: string,
  res: Response
): Promise<void> {
  try {
    const checkpoints = await listCheckpoints(scope, scopeId);
    res.status(200).json({ success: true, data: checkpoints });
  } catch (err) {
    internalError(res, err, 'list checkpoints');
  }
}

export async function createSpecCheckpointHandler(req: Request, res: Response): Promise<void> {
  const specId = parseScopeId(req, res, 'spec');
  if (!specId) return;
  const body = parseCreateBody(req, res);
  if (!body) return;
  await createCheckpointForScope('spec', specId, body, res);
}

export async function listSpecCheckpointsHandler(req: Request, res: Response): Promise<void> {
  const specId = parseScopeId(req, res, 'spec');
  if (!specId) return;
  await listCheckpointsForScope('spec', specId, res);
}

export async function createProjectCheckpointHandler(req: Request, res: Response): Promise<void> {
  const projectId = parseScopeId(req, res, 'project');
  if (!projectId) return;
  const body = parseCreateBody(req, res);
  if (!body) return;
  await createCheckpointForScope('project', projectId, body, res);
}

export async function listProjectCheckpointsHandler(req: Request, res: Response): Promise<void> {
  const projectId = parseScopeId(req, res, 'project');
  if (!projectId) return;
  await listCheckpointsForScope('project', projectId, res);
}

export async function getCheckpointHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    badRequest(res, 'invalid checkpoint id');
    return;
  }
  try {
    const checkpoint = await getCheckpointById(id.data);
    if (!checkpoint) {
      res.status(404).json({ success: false, error: 'checkpoint not found' });
      return;
    }
    res.status(200).json({ success: true, data: checkpoint });
  } catch (err) {
    internalError(res, err, 'get checkpoint');
  }
}
