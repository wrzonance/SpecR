import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { assertDocxSafe } from '../parser/index.js';
import { computeSpecDiff, MergeError } from '../merge/index.js';
import { logger } from '../lib/logger.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type UploadValidation =
  | { readonly ok: true; readonly buffer: Buffer }
  | { readonly ok: false; readonly status: 400 | 422; readonly error: string };

async function validateDocxUpload(req: Request): Promise<UploadValidation> {
  if (!req.file) return { ok: false, status: 400, error: 'DOCX file required' };
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (ext !== '.docx' || req.file.mimetype !== DOCX_MIME) {
    return { ok: false, status: 422, error: 'DOCX file required' };
  }
  try {
    await assertDocxSafe(req.file.buffer);
    return { ok: true, buffer: req.file.buffer };
  } catch (err) {
    logger.warn({ err }, 'diff upload rejected');
    return { ok: false, status: 422, error: 'invalid DOCX file' };
  }
}

export async function diffHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const upload = await validateDocxUpload(req);
  if (!upload.ok) {
    res.status(upload.status).json({ success: false, error: upload.error });
    return;
  }
  try {
    const diff = await computeSpecDiff(idResult.data, upload.buffer);
    if (!diff) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: diff });
  } catch (err) {
    if (err instanceof MergeError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'diff failed');
    res.status(500).json({ success: false, error: 'diff failed' });
  }
}
