import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  listRequiredSections,
  setRequiredSections,
  seedRequiredSections,
  RequiredSectionsProjectNotFoundError,
  RequiredSectionsPackageNotFoundError,
  RequiredSectionsSeedConflictError,
  RequiredSectionsInvalidSeedError,
  pool,
  type RequiredScope,
  type SeedSource,
} from '../db/index.js';
import type { RequiredSectionsBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

function seedSourceFrom(seedFrom: NonNullable<RequiredSectionsBody['seedFrom']>): SeedSource {
  if (seedFrom === 'baseline') return { from: 'baseline' };
  if (seedFrom === 'toc') return { from: 'toc' };
  return { from: 'package', packageId: seedFrom.packageId };
}

async function applyBody(scope: RequiredScope, body: RequiredSectionsBody) {
  if (body.seedFrom !== undefined)
    return seedRequiredSections(scope, seedSourceFrom(body.seedFrom), pool);
  return setRequiredSections(scope, body.sections ?? [], pool);
}

function mapError(err: unknown, res: Response, where: string): void {
  if (
    err instanceof RequiredSectionsProjectNotFoundError ||
    err instanceof RequiredSectionsPackageNotFoundError
  ) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof RequiredSectionsSeedConflictError) {
    res.status(409).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof RequiredSectionsInvalidSeedError) {
    res.status(422).json({ success: false, error: err.message });
    return;
  }
  const mapped = pgErrorToHttp(err);
  if (mapped) {
    res.status(mapped.status).json({ success: false, error: mapped.error });
    return;
  }
  logger.error({ err }, `${where} failed`);
  res.status(500).json({ success: false, error: 'internal server error' });
}

function parseProjectId(req: Request, res: Response): string | null {
  const parsed = z.uuid().safeParse(req.params['id']);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return null;
  }
  return parsed.data;
}

function parsePackageId(req: Request, res: Response): string | null {
  const parsed = z.uuid().safeParse(req.params['packageId']);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid package id' });
    return null;
  }
  return parsed.data;
}

export async function listBaselineRequiredSectionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  try {
    const data = await listRequiredSections({ kind: 'baseline', projectId });
    res.status(200).json({ success: true, data });
  } catch (err) {
    mapError(err, res, 'list baseline required-sections');
  }
}

export async function putBaselineRequiredSectionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  try {
    const data = await applyBody({ kind: 'baseline', projectId }, req.body as RequiredSectionsBody);
    res.status(200).json({ success: true, data });
  } catch (err) {
    mapError(err, res, 'put baseline required-sections');
  }
}

export async function listPackageRequiredSectionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  const packageId = parsePackageId(req, res);
  if (!packageId) return;
  try {
    const data = await listRequiredSections({ kind: 'package', projectId, packageId });
    res.status(200).json({ success: true, data });
  } catch (err) {
    mapError(err, res, 'list package required-sections');
  }
}

export async function putPackageRequiredSectionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  const packageId = parsePackageId(req, res);
  if (!packageId) return;
  try {
    const data = await applyBody(
      { kind: 'package', projectId, packageId },
      req.body as RequiredSectionsBody
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    mapError(err, res, 'put package required-sections');
  }
}
