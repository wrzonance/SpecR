import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  createClient,
  listClients,
  getClient,
  updateClient,
  ClientLibraryNotFoundError,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';
import { SectionNumberFormatSchema } from '../lib/section-number.js';

const UUID_SCHEMA = z.uuid();
const CreateClientBody = z.object({
  name: z.string().check(z.minLength(1)),
  libraryId: z.uuid().optional(),
  sectionNumberFormat: SectionNumberFormatSchema.optional(),
});
const UpdateClientBody = z.object({ sectionNumberFormat: SectionNumberFormatSchema });

export async function createClientHandler(req: Request, res: Response): Promise<void> {
  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'name is required' });
    return;
  }
  const input = {
    name: parsed.data.name,
    ...(parsed.data.libraryId ? { libraryId: parsed.data.libraryId } : {}),
    ...(parsed.data.sectionNumberFormat
      ? { sectionNumberFormat: parsed.data.sectionNumberFormat }
      : {}),
  };
  try {
    const client = await createClient(input);
    res.status(201).json({ success: true, data: client });
  } catch (err) {
    if (err instanceof ClientLibraryNotFoundError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    const mapped = pgErrorToHttp(err, { '23505': 'a client with that name already exists' });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'create client failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function updateClientHandler(req: Request, res: Response): Promise<void> {
  const id = UUID_SCHEMA.safeParse(req.params['id']);
  const body = UpdateClientBody.safeParse(req.body);
  if (!id.success || !body.success) {
    res.status(400).json({ success: false, error: 'invalid client update' });
    return;
  }
  try {
    const client = await updateClient(id.data, body.data);
    if (!client) {
      res.status(404).json({ success: false, error: 'client not found' });
      return;
    }
    res.status(200).json({ success: true, data: client });
  } catch (err) {
    logger.error({ err }, 'update client failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function listClientsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const clients = await listClients();
    res.status(200).json({ success: true, data: clients });
  } catch (err) {
    logger.error({ err }, 'list clients failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getClientHandler(req: Request, res: Response): Promise<void> {
  const parsed = UUID_SCHEMA.safeParse(req.params['id']);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid client id' });
    return;
  }
  try {
    const client = await getClient(parsed.data);
    if (!client) {
      res.status(404).json({ success: false, error: 'client not found' });
      return;
    }
    res.status(200).json({ success: true, data: client });
  } catch (err) {
    logger.error({ err }, 'get client failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
