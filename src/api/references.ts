import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  deleteReference,
  findProjectById,
  getInboundReferences,
  getOutboundReferences,
  isSpecInProject,
  pool,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { normalizeSectionNumber } from '../lib/section-number.js';

type ParsedValue = { readonly ok: true; readonly value: string } | { readonly ok: false };

const UuidSchema = z.uuid();

function parseUuid(value: unknown): ParsedValue {
  const result = UuidSchema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

function parseSection(value: unknown): ParsedValue {
  if (typeof value !== 'string') {
    return { ok: false };
  }
  const normalized = normalizeSectionNumber(value);
  return normalized === null ? { ok: false } : { ok: true, value: normalized };
}

async function projectExists(projectId: string): Promise<boolean> {
  const project = await findProjectById(projectId, pool);
  return project !== null;
}

// DELETE /specs/:id/references/:refId
// Removes a single cross-reference while leaving its paragraph in place
// (Feature B: "delete the reference only" after an edit removed the citation).
export async function deleteReferenceHandler(req: Request, res: Response): Promise<void> {
  const specId = req.params['id'];
  const refId = req.params['refId'];
  if (!specId || typeof specId !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  if (!refId || typeof refId !== 'string') {
    res.status(400).json({ success: false, error: 'missing reference id' });
    return;
  }
  try {
    const removed = await deleteReference(refId, specId);
    if (!removed) {
      res.status(404).json({ success: false, error: 'reference not found' });
      return;
    }
    res.status(200).json({ success: true, data: { specId, refId } });
  } catch (err) {
    logger.error({ err }, 'delete reference failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getInboundReferencesHandler(req: Request, res: Response): Promise<void> {
  const projectId = parseUuid(req.params['id']);
  if (!projectId.ok) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  const section = parseSection(req.query['section']);
  if (!section.ok) {
    res.status(400).json({ success: false, error: 'invalid section' });
    return;
  }
  try {
    if (!(await projectExists(projectId.value))) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    const refs = await getInboundReferences(section.value, projectId.value, pool);
    res.status(200).json({
      success: true,
      data: { projectId: projectId.value, section: section.value, references: refs },
    });
  } catch (err) {
    logger.error({ err }, 'get inbound references failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getOutboundReferencesHandler(req: Request, res: Response): Promise<void> {
  const projectId = parseUuid(req.params['id']);
  const specId = parseUuid(req.params['specId']);
  if (!projectId.ok) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  if (!specId.ok) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    if (!(await projectExists(projectId.value))) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    if (!(await isSpecInProject(specId.value, projectId.value, pool))) {
      res.status(404).json({ success: false, error: 'spec not in project' });
      return;
    }
    const refs = await getOutboundReferences(specId.value, projectId.value, pool);
    res.status(200).json({
      success: true,
      data: { projectId: projectId.value, specId: specId.value, references: refs },
    });
  } catch (err) {
    logger.error({ err }, 'get outbound references failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
