import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  findLibraryById,
  listDisciplines,
  replaceLibraryDisciplineRules,
  clearLibraryDisciplineRules,
  DisciplineNotFoundError,
} from '../db/index.js';
import { SetDisciplinesBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';

const UUID_SCHEMA = z.uuid();

// Parse the :id library param, replying 400 on a malformed UUID.
function parseLibraryId(req: Request, res: Response): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: 'invalid library id' });
    return null;
  }
  return result.data;
}

// Confirm the library exists, replying 404 if not. Returns true when present.
async function requireLibrary(libraryId: string, res: Response): Promise<boolean> {
  const library = await findLibraryById(libraryId);
  if (!library) {
    res.status(404).json({ success: false, error: 'library not found' });
    return false;
  }
  return true;
}

/**
 * GET /disciplines — the discipline catalog with each discipline's division rules resolved
 * for an optional `libraryId` (built-in default when omitted or when the library has no rules
 * of its own). `meta.inherited` is true when the built-in default backs the result.
 */
export async function listDisciplinesHandler(req: Request, res: Response): Promise<void> {
  const raw = req.query['libraryId'];
  let libraryId: string | undefined;
  if (raw !== undefined) {
    // A repeated/structured libraryId parses to an array/object — reject it rather than
    // silently dropping the filter and resolving the built-in default (matches the discipline
    // filter guard on the spec listings).
    if (typeof raw !== 'string') {
      res.status(400).json({ success: false, error: 'libraryId must be a single value' });
      return;
    }
    const parsed = UUID_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'invalid libraryId' });
      return;
    }
    libraryId = parsed.data;
  }
  try {
    if (libraryId !== undefined && !(await requireLibrary(libraryId, res))) return;
    const resolved = await listDisciplines(libraryId);
    res
      .status(200)
      .json({ success: true, data: resolved.disciplines, meta: { inherited: resolved.inherited } });
  } catch (err) {
    logger.error({ err }, 'list disciplines failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

/**
 * PUT /libraries/{id}/disciplines — replace a library's discipline rule set wholesale.
 * Malformed body → 400; an unknown discipline key → 422; unknown library → 404.
 */
export async function putLibraryDisciplinesHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseLibraryId(req, res);
  if (!libraryId) return;
  const parsed = SetDisciplinesBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'malformed discipline rules' });
    return;
  }
  try {
    if (!(await requireLibrary(libraryId, res))) return;
    await replaceLibraryDisciplineRules(libraryId, parsed.data.rules);
    const resolved = await listDisciplines(libraryId);
    res.status(200).json({ success: true, data: resolved.disciplines, meta: { inherited: false } });
  } catch (err) {
    if (err instanceof DisciplineNotFoundError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'put library disciplines failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

/**
 * DELETE /libraries/{id}/disciplines — clear a library's override, reverting it to the
 * built-in default. `data.cleared` is true when an override was removed, false when the
 * library already had none (idempotent). Unknown library → 404.
 */
export async function clearLibraryDisciplinesHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseLibraryId(req, res);
  if (!libraryId) return;
  try {
    if (!(await requireLibrary(libraryId, res))) return;
    const cleared = await clearLibraryDisciplineRules(libraryId);
    res.status(200).json({ success: true, data: { cleared } });
  } catch (err) {
    logger.error({ err }, 'clear library disciplines failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
