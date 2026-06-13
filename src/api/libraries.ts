import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createLibrary,
  DEFAULT_COMPANY_LIBRARY,
  listLibraries,
  listLibrarySpecs,
  pool,
  updateLibraryName,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { getPgCode } from './pg-error.js';

const CreateClientLibraryBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
});

const RenameLibraryBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
});

export async function listLibrariesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const libraries = await listLibraries(pool);
    res.status(200).json({ success: true, data: libraries });
  } catch (err) {
    logger.error({ err }, 'list libraries failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function createClientLibraryHandler(req: Request, res: Response): Promise<void> {
  const parsed = CreateClientLibraryBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid request body' });
    return;
  }
  try {
    const libraries = await listLibraries(pool);
    const company = libraries.find((lib) => lib.name === DEFAULT_COMPANY_LIBRARY);
    if (!company) {
      res.status(500).json({ success: false, error: 'default company master missing' });
      return;
    }
    const library = await createLibrary(
      {
        tier: 'client',
        name: parsed.data.name,
        owner: parsed.data.name,
        parentLibraryId: company.id,
      },
      pool
    );
    res.status(201).json({ success: true, data: library });
  } catch (err) {
    if (getPgCode(err) === '23505') {
      res.status(409).json({ success: false, error: 'library name already exists' });
      return;
    }
    logger.error({ err }, 'create client library failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function renameLibraryHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing library id' });
    return;
  }
  const parsed = RenameLibraryBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid request body' });
    return;
  }
  try {
    const library = await updateLibraryName(id, parsed.data.name, pool);
    if (!library) {
      res.status(404).json({ success: false, error: 'library not found' });
      return;
    }
    res.status(200).json({ success: true, data: library });
  } catch (err) {
    if (getPgCode(err) === '23505') {
      res.status(409).json({ success: false, error: 'library name already exists' });
      return;
    }
    logger.error({ err }, 'rename library failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function listLibrarySpecsHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing library id' });
    return;
  }
  try {
    const specs = await listLibrarySpecs(id, pool);
    if (!specs) {
      res.status(404).json({ success: false, error: 'library not found' });
      return;
    }
    res.status(200).json({ success: true, data: specs });
  } catch (err) {
    logger.error({ err }, 'list library specs failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
