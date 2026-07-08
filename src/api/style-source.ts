import { z } from 'zod';
import type { Request, Response } from 'express';
import { getTemplate, setSpecStyleSource, clearSpecStyleSource } from '../db/index.js';
import type { SetStyleSourceBody } from '../ast/index.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';

const UUID_SCHEMA = z.uuid();

function parseSpecId(req: Request, res: Response): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return null;
  }
  return result.data;
}

export async function setStyleSourceHandler(req: Request, res: Response): Promise<void> {
  const specId = parseSpecId(req, res);
  if (!specId) return;
  // Body already validated + parsed by validateBody middleware.
  const { templateId } = req.body as SetStyleSourceBody;
  try {
    // Pre-check template existence explicitly: pg 23503 is ambiguous (it also
    // means 409 on a delete-while-referenced), so we never let the FK error
    // decide the status — a missing template here is a clean 404.
    const template = await getTemplate(templateId);
    if (!template) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    const outcome = await setSpecStyleSource(specId, templateId);
    if (outcome === 'spec-not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    if (outcome === 'template-not-found') {
      // Race: the template was deleted between the pre-check above and the UPDATE
      // (#366). The EXISTS predicate matched zero rows, so surface the same clean
      // 404 as the pre-check, not a 409 scope error.
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    if (outcome === 'library-mismatch') {
      // Status set at the handler (the error middleware only maps .status on thrown
      // boundary errors) — mirrors the numbering-profile assign 409.
      res.status(409).json({
        success: false,
        error: 'style template belongs to a different library than the spec',
      });
      return;
    }
    res.status(200).json({ success: true, data: { templateId, templateName: template.name } });
  } catch (err) {
    // Backstop for the same delete race in its ultra-narrow window: the EXISTS
    // subquery (statement snapshot) still sees the template but the RI FK trigger's
    // up-to-date check finds it gone → 23503. Map that to the same 404 rather than
    // leaking a 500. The common race is handled by 'template-not-found' above (#366).
    if (getPgCode(err) === '23503') {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    logger.error({ err }, 'set style source failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function clearStyleSourceHandler(req: Request, res: Response): Promise<void> {
  const specId = parseSpecId(req, res);
  if (!specId) return;
  try {
    const cleared = await clearSpecStyleSource(specId);
    if (!cleared) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    // Idempotent: clearing an already-null association still succeeds.
    res.status(200).json({ success: true, data: { styleSource: null } });
  } catch (err) {
    logger.error({ err }, 'clear style source failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
