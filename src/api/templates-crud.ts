import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplateMeta,
  deleteTemplate,
  bulkUpsertTemplateRules,
} from '../db/index.js';
import type { CreateTemplateBody, PatchTemplateBody, UpsertStyleRulesBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

const UUID_SCHEMA = z.uuid();

// Caller-specific wording for the pg-code → HTTP mapping.
const TEMPLATE_PG_MESSAGES = {
  '23505': 'template name already exists',
  '23514': 'rule violates check constraint',
} as const;

function parseId(req: Request, res: Response): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: 'invalid template id' });
    return null;
  }
  return result.data;
}

// Shared catch tail: pg-mapped status if recognised, else logged 500.
function sendDbError(err: unknown, res: Response, logMsg: string): void {
  const mapped = pgErrorToHttp(err, TEMPLATE_PG_MESSAGES);
  if (mapped) {
    res.status(mapped.status).json({ success: false, error: mapped.error });
    return;
  }
  logger.error({ err }, logMsg);
  res.status(500).json({ success: false, error: 'internal server error' });
}

export async function createTemplateHandler(req: Request, res: Response): Promise<void> {
  // Body already validated + parsed by validateBody middleware.
  const { name, owner } = req.body as CreateTemplateBody;
  try {
    const meta = await createTemplate(name, owner);
    res.status(201).json({ success: true, data: meta });
  } catch (err) {
    sendDbError(err, res, 'create template failed');
  }
}

export async function listTemplatesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const templates = await listTemplates();
    res.status(200).json({ success: true, data: templates });
  } catch (err) {
    logger.error({ err }, 'list templates failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getTemplateHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res);
  if (!id) return;
  try {
    const template = await getTemplate(id);
    if (!template) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    res.status(200).json({ success: true, data: template });
  } catch (err) {
    logger.error({ err }, 'get template failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function patchTemplateHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res);
  if (!id) return;
  // Body already validated + parsed by validateBody middleware.
  const patch = req.body as PatchTemplateBody;
  try {
    const meta = await updateTemplateMeta(id, patch);
    if (!meta) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    res.status(200).json({ success: true, data: meta });
  } catch (err) {
    sendDbError(err, res, 'patch template failed');
  }
}

export async function deleteTemplateHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res);
  if (!id) return;
  try {
    const deleted = await deleteTemplate(id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    logger.error({ err }, 'delete template failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function upsertTemplateRulesHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res);
  if (!id) return;
  // Body already validated + parsed by validateBody middleware.
  const { rules } = req.body as UpsertStyleRulesBody;
  try {
    const template = await bulkUpsertTemplateRules(id, rules);
    if (!template) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    res.status(200).json({ success: true, data: template });
  } catch (err) {
    sendDbError(err, res, 'upsert template rules failed');
  }
}
