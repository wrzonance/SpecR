import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplateMeta,
  deleteTemplate,
  replaceTemplateRules,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { getPgCode } from '../lib/pg-errors.js';

const UUID_SCHEMA = z.uuid();

function parseId(req: Request, res: Response): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: 'invalid template id' });
    return null;
  }
  return result.data;
}

export async function createTemplateHandler(req: Request, res: Response): Promise<void> {
  // Body already validated + parsed by validateBody middleware.
  const { name, owner } = req.body as { name: string; owner?: string };
  try {
    const meta = await createTemplate(name, owner);
    res.status(201).json({ success: true, data: meta });
  } catch (err) {
    if (getPgCode(err) === '23505') {
      res.status(409).json({ success: false, error: 'template name already exists' });
      return;
    }
    logger.error({ err }, 'create template failed');
    res.status(500).json({ success: false, error: 'internal server error' });
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
  const patch = req.body as { name?: string; owner?: string | null };
  try {
    const meta = await updateTemplateMeta(id, patch);
    if (!meta) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    res.status(200).json({ success: true, data: meta });
  } catch (err) {
    if (getPgCode(err) === '23505') {
      res.status(409).json({ success: false, error: 'template name already exists' });
      return;
    }
    logger.error({ err }, 'patch template failed');
    res.status(500).json({ success: false, error: 'internal server error' });
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
  const { rules } = req.body as {
    rules: Array<{ nodeType: string; properties: Record<string, unknown> }>;
  };
  try {
    const template = await replaceTemplateRules(
      id,
      rules as Parameters<typeof replaceTemplateRules>[1]
    );
    if (!template) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    res.status(200).json({ success: true, data: template });
  } catch (err) {
    if (getPgCode(err) === '23514') {
      res.status(422).json({ success: false, error: 'rule violates check constraint' });
      return;
    }
    logger.error({ err }, 'upsert template rules failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
