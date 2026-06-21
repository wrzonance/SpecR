import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  findLibraryById,
  findLibraryByName,
  listLibraries,
  listLibrarySpecs,
  createLibrary,
  updateLibraryName,
  DEFAULT_COMPANY_LIBRARY,
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

// Resolves a client library's parent: an explicit company-tier library, or the
// seeded Default Company Master. Sends the error response and returns null on
// 404 (unknown) / 422 (not company-tier) / 500 (default master missing).
async function resolveClientParent(
  parentLibraryId: string | undefined,
  res: Response
): Promise<{ readonly id: string } | null> {
  if (parentLibraryId) {
    const parent = await findLibraryById(parentLibraryId);
    if (!parent) {
      res.status(404).json({ success: false, error: 'parent library not found' });
      return null;
    }
    if (parent.tier !== 'company') {
      res.status(422).json({ success: false, error: 'parent library must be company-tier' });
      return null;
    }
    return parent;
  }
  const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
  if (!company) {
    res.status(500).json({ success: false, error: 'default company library missing' });
    return null;
  }
  if (company.tier !== 'company') {
    res.status(500).json({ success: false, error: 'default company library misconfigured' });
    return null;
  }
  return company;
}

export async function createClientLibraryHandler(req: Request, res: Response): Promise<void> {
  const parsed = CreateClientLibraryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'name is required' });
    return;
  }
  try {
    const parent = await resolveClientParent(parsed.data.parentLibraryId, res);
    if (!parent) return; // resolveClientParent already replied
    const library = await createLibrary({
      tier: 'client',
      name: parsed.data.name,
      owner: parsed.data.name,
      parentLibraryId: parent.id,
    });
    res.status(201).json({ success: true, data: library });
  } catch (err) {
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
