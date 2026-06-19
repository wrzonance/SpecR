import { z } from 'zod';
import type { Request, Response } from 'express';
import { findLibraryById, listLibraries, listLibrarySpecs } from '../db/index.js';
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
