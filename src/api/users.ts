import { z } from 'zod';
import type { Request, Response } from 'express';
import { resolveOrCreateUserByLabel, listUsers, getUser } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { codePointMax } from '../lib/length-limit.js';
import { MAX_LABEL_LENGTH } from '../lib/label-length.js';

const UUID_SCHEMA = z.uuid();

// #642, ADR-091: bounded in UNICODE CODE POINTS (matching the openapi.yaml
// maxLength keyword it's paired with), not UTF-16 code units.
export const ResolveUserBody = z.object({
  label: codePointMax(z.string().trim().min(1), MAX_LABEL_LENGTH, {
    description:
      'Leading/trailing whitespace is trimmed before resolution, and whitespace-only values ' +
      `are rejected; the 1-${MAX_LABEL_LENGTH} length bounds (Unicode code points) apply to ` +
      'the trimmed value.',
  }),
});

export async function resolveUserHandler(req: Request, res: Response): Promise<void> {
  const parsed = ResolveUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'label is required (1-200 characters)' });
    return;
  }
  try {
    const user = await resolveOrCreateUserByLabel(parsed.data.label);
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    logger.error({ err }, 'resolve user failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function listUsersHandler(_req: Request, res: Response): Promise<void> {
  try {
    const users = await listUsers();
    res.status(200).json({ success: true, data: users });
  } catch (err) {
    logger.error({ err }, 'list users failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getUserHandler(req: Request, res: Response): Promise<void> {
  const parsed = UUID_SCHEMA.safeParse(req.params['id']);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid user id' });
    return;
  }
  try {
    const user = await getUser(parsed.data);
    if (!user) {
      res.status(404).json({ success: false, error: 'user not found' });
      return;
    }
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    logger.error({ err }, 'get user failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
