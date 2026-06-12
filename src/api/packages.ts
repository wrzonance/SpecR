import type { Request, Response } from 'express';
import {
  createPackage,
  listPackages,
  setPackageSpecs,
  deletePackage,
  PackageNotFoundError,
  SpecNotInProjectError,
  pool,
} from '../db/index.js';
import type { CreatePackageBody, SetPackageSpecsBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

export async function createPackageHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const body = req.body as CreatePackageBody;
    const pkg = await createPackage(id, body.name, pool);
    res.status(201).json({ success: true, data: pkg });
  } catch (err) {
    const mapped = pgErrorToHttp(err, {
      '23503': 'project not found',
      '23505': 'package name already exists in this project',
    });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'create package failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function listPackagesHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const packages = await listPackages(id, pool);
    if (packages === null) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: packages });
  } catch (err) {
    logger.error({ err }, 'list packages failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function setPackageSpecsHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing package id' });
    return;
  }
  try {
    const body = req.body as SetPackageSpecsBody;
    const specs = await setPackageSpecs(id, body.specIds, pool);
    res.status(200).json({ success: true, data: { packageId: id, specs } });
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    if (err instanceof SpecNotInProjectError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'set package specs failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function deletePackageHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing package id' });
    return;
  }
  try {
    const deleted = await deletePackage(id, pool);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    res.status(200).json({ success: true, data: { packageId: id } });
  } catch (err) {
    logger.error({ err }, 'delete package failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
