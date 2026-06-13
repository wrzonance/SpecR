import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getCoordinationReport,
  listPackageRequiredSections,
  listProjectRequiredSections,
  PackageNotFoundError,
  pool,
  ProjectNotFoundError,
  setPackageRequiredSections,
  setProjectRequiredSections,
} from '../db/index.js';
import type { SetRequiredSectionsBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

function paramId(req: Request, res: Response, label: string): string | null {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: `missing ${label} id` });
    return null;
  }
  return id;
}

export async function getCoordinationReportHandler(req: Request, res: Response): Promise<void> {
  const id = paramId(req, res, 'project');
  if (!id) return;
  const rawPackageId = req.query['packageId'];
  const packageId = typeof rawPackageId === 'string' ? rawPackageId : undefined;
  if (packageId !== undefined && !z.uuid().safeParse(packageId).success) {
    res.status(422).json({ success: false, error: 'packageId must be a uuid' });
    return;
  }
  try {
    const report = await getCoordinationReport(id, packageId, pool);
    if (report === null) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    logger.error({ err }, 'get coordination report failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function setProjectRequiredSectionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const id = paramId(req, res, 'project');
  if (!id) return;
  try {
    const body = req.body as SetRequiredSectionsBody;
    const sections = await setProjectRequiredSections(id, body.sections, pool);
    res.status(200).json({ success: true, data: { projectId: id, sections } });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    const mapped = pgErrorToHttp(err, {
      '23505': 'required section already exists in this scope',
      '23514': 'section must be a canonical CSI section number',
    });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'set project required sections failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function setPackageRequiredSectionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const id = paramId(req, res, 'package');
  if (!id) return;
  try {
    const body = req.body as SetRequiredSectionsBody;
    const sections = await setPackageRequiredSections(id, body.sections, pool);
    res.status(200).json({ success: true, data: { packageId: id, sections } });
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    const mapped = pgErrorToHttp(err, {
      '23505': 'required section already exists in this scope',
      '23514': 'section must be a canonical CSI section number',
    });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'set package required sections failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getProjectRequiredSectionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const id = paramId(req, res, 'project');
  if (!id) return;
  try {
    const sections = await listProjectRequiredSections(id, pool);
    if (sections === null) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: { projectId: id, sections } });
  } catch (err) {
    logger.error({ err }, 'get project required sections failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getPackageRequiredSectionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const id = paramId(req, res, 'package');
  if (!id) return;
  try {
    const sections = await listPackageRequiredSections(id, pool);
    if (sections === null) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    res.status(200).json({ success: true, data: { packageId: id, sections } });
  } catch (err) {
    logger.error({ err }, 'get package required sections failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
