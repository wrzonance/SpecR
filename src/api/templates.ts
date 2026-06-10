import path from 'node:path';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { analyzeDocxStyles, deriveTemplate, assertDocxSafe, ParserError } from '../parser/index.js';
import { createTemplateWithRules } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ImportBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
  owner: z.string().check(z.minLength(1)).exactOptional(),
});

function validateRequest(
  req: Request
): { error: string } | { file: Express.Multer.File; name: string; owner: string | undefined } {
  if (!req.file) return { error: 'file required' };

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (ext !== '.docx') return { error: 'unsupported file extension — only .docx is accepted' };
  if (req.file.mimetype !== DOCX_MIME) return { error: 'MIME type mismatch for .docx' };

  const bodyResult = ImportBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) return { error: 'name is required' };

  return { file: req.file, name: bodyResult.data.name, owner: bodyResult.data.owner };
}

export async function importTemplateHandler(req: Request, res: Response): Promise<void> {
  const validation = validateRequest(req);
  if ('error' in validation) {
    res.status(400).json({ success: false, error: validation.error });
    return;
  }

  const { file, name, owner } = validation;
  const buffer = file.buffer;

  try {
    await assertDocxSafe(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid file';
    res.status(400).json({ success: false, error: message });
    return;
  }

  try {
    // Buffer is analysis-only and never persisted (ADR-021).
    const analysis = await analyzeDocxStyles(buffer);
    const { rules, report } = deriveTemplate(analysis.classified, analysis.effectiveStyles);

    if (rules.length === 0) {
      res.status(422).json({
        success: false,
        error: 'document contains no styleable paragraphs to derive a template from',
      });
      return;
    }

    const template = await createTemplateWithRules(name, owner ?? null, rules);
    res.status(201).json({ success: true, data: { template, report } });
  } catch (err) {
    const mapped = pgErrorToHttp(err, { '23505': 'template name already exists' });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    if (err instanceof ParserError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'template import failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
