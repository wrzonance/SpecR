import type { Request, Response } from 'express';
import { z } from 'zod';
import type { SubmittalRegisterBody } from '../ast/index.js';
import {
  getSubmittalRegister,
  SubmittalRegisterProjectNotFoundError,
  SubmittalRegisterSpecNotInProjectError,
} from '../db/index.js';

function mapError(err: unknown, res: Response): void {
  if (
    err instanceof SubmittalRegisterProjectNotFoundError ||
    err instanceof SubmittalRegisterSpecNotInProjectError
  ) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'submittal register failed' });
}

export async function postSubmittalRegisterHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  try {
    const body = req.body as SubmittalRegisterBody;
    const register = await getSubmittalRegister(id.data, body.specIds);
    res.status(200).json({ success: true, data: register });
  } catch (err) {
    mapError(err, res);
  }
}
