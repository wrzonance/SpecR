import type { Request, Response } from 'express';
import { z } from 'zod';
import {
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
