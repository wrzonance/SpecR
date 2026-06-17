import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  findLibraryById,
  listBuiltInConventions,
  getBuiltInConvention,
  getConventionForLibrary,
  findConventionById,
  upsertLibraryConvention,
  ConventionValidationError,
} from '../db/index.js';
import type { EditingConvention } from '../db/index.js';
import { PutConventionBodySchema, CloneConventionBodySchema } from '../ast/index.js';
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

// Map an unsafe-regex write rejection to 422; anything else to a logged 500.
function sendWriteError(err: unknown, res: Response, logMsg: string): void {
  if (err instanceof ConventionValidationError) {
    res.status(422).json({ success: false, error: err.message });
    return;
  }
  logger.error({ err }, logMsg);
  res.status(500).json({ success: false, error: 'internal server error' });
}

export async function listConventionsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const conventions = await listBuiltInConventions();
    res.status(200).json({ success: true, data: conventions });
  } catch (err) {
    logger.error({ err }, 'list conventions failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getLibraryConventionHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseLibraryId(req, res);
  if (!libraryId) return;
  try {
    if (!(await requireLibrary(libraryId, res))) return;
    const resolved = await getConventionForLibrary(libraryId);
    if (!resolved) {
      res.status(404).json({ success: false, error: 'no convention available' });
      return;
    }
    // A null libraryId on the resolved row means the library has no profile of
    // its own and inherits the built-in industry default — flag it as such.
    const inherited = resolved.libraryId === null;
    res.status(200).json({ success: true, data: resolved, meta: { inherited } });
  } catch (err) {
    logger.error({ err }, 'get library convention failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function putLibraryConventionHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseLibraryId(req, res);
  if (!libraryId) return;
  // Malformed rules → 400 (shape). Unsafe regex → 422 (write boundary, below).
  const parsed = PutConventionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'malformed convention body' });
    return;
  }
  try {
    if (!(await requireLibrary(libraryId, res))) return;
    const convention = await upsertLibraryConvention(
      libraryId,
      parsed.data.name,
      parsed.data.rules ?? {}
    );
    res.status(200).json({ success: true, data: convention });
  } catch (err) {
    sendWriteError(err, res, 'put library convention failed');
  }
}

// Resolve the clone source: a built-in (library_id IS NULL) or any profile by id.
async function resolveCloneSource(sourceId: string): Promise<EditingConvention | null> {
  const builtIn = await getBuiltInConvention();
  if (builtIn && builtIn.id === sourceId) return builtIn;
  return findConventionById(sourceId);
}

export async function cloneLibraryConventionHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseLibraryId(req, res);
  if (!libraryId) return;
  const parsed = CloneConventionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'malformed clone body' });
    return;
  }
  try {
    if (!(await requireLibrary(libraryId, res))) return;
    const source = await resolveCloneSource(parsed.data.sourceId);
    if (!source) {
      res.status(404).json({ success: false, error: 'source convention not found' });
      return;
    }
    const convention = await upsertLibraryConvention(libraryId, source.name, source.rules);
    res.status(201).json({ success: true, data: convention });
  } catch (err) {
    sendWriteError(err, res, 'clone library convention failed');
  }
}
