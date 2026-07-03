import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  findLibraryById,
  listLibraries,
  listLibrarySpecs,
  createClientLibrary,
  updateLibraryName,
  ParentLibraryNotFoundError,
  ParentLibraryNotCompanyError,
  DefaultCompanyLibraryError,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

const UUID_SCHEMA = z.uuid();
const CreateClientLibraryBody = z.object({
  name: z.string().check(z.minLength(1)),
  parentLibraryId: z.uuid().exactOptional(),
});
const RenameLibraryBody = z.object({ name: z.string().check(z.minLength(1)) });

// Parse the :id library param, replying 400 on a malformed UUID.
function parseLibraryId(req: Request, res: Response): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: 'invalid library id' });
    return null;
  }
  return result.data;
}

export async function listLibrariesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const libraries = await listLibraries();
    res.status(200).json({ success: true, data: libraries });
  } catch (err) {
    logger.error({ err }, 'list libraries failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function listLibrarySpecsHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseLibraryId(req, res);
  if (!libraryId) return;
  try {
    const library = await findLibraryById(libraryId);
    if (!library) {
      res.status(404).json({ success: false, error: 'library not found' });
      return;
    }
    const specs = await listLibrarySpecs(libraryId);
    res.status(200).json({ success: true, data: specs });
  } catch (err) {
    logger.error({ err }, 'list library specs failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

// Maps a client-library parent-resolution failure to its HTTP status. Returns
// null for any other error (falls through to pg/500 handling).
function clientParentErrorStatus(err: unknown): number | null {
  if (err instanceof ParentLibraryNotFoundError) return 404;
  if (err instanceof ParentLibraryNotCompanyError) return 422;
  if (err instanceof DefaultCompanyLibraryError) return 500;
  return null;
}

export async function createClientLibraryHandler(req: Request, res: Response): Promise<void> {
  const parsed = CreateClientLibraryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'name is required' });
    return;
  }
  const input = parsed.data.parentLibraryId
    ? { name: parsed.data.name, parentLibraryId: parsed.data.parentLibraryId }
    : { name: parsed.data.name };
  try {
    const library = await createClientLibrary(input);
    res.status(201).json({ success: true, data: library });
  } catch (err) {
    const parentStatus = clientParentErrorStatus(err);
    if (parentStatus !== null && err instanceof Error) {
      res.status(parentStatus).json({ success: false, error: err.message });
      return;
    }
    const mapped = pgErrorToHttp(err, { '23505': 'a library with that name already exists' });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'create client library failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function renameLibraryHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseLibraryId(req, res);
  if (!libraryId) return;
  const parsed = RenameLibraryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'name is required' });
    return;
  }
  try {
    const existing = await findLibraryById(libraryId);
    if (!existing) {
      res.status(404).json({ success: false, error: 'library not found' });
      return;
    }
    if (existing.tier !== 'client') {
      res.status(422).json({ success: false, error: 'only client libraries can be renamed' });
      return;
    }
    const updated = await updateLibraryName(libraryId, parsed.data.name);
    if (!updated) {
      res.status(404).json({ success: false, error: 'library not found' });
      return;
    }
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    const mapped = pgErrorToHttp(err, { '23505': 'a library with that name already exists' });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'rename library failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
