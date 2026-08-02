import type { Request, Response } from 'express';
import { z } from 'zod';
import { parsePathUuid } from './path-params.js';
import {
  getSpecTree,
  updateSpec,
  getSpecLineage,
  getSpecStyleSource,
  getOnboardingStatus,
  getSpecWithdrawnAt,
  withdrawSpec,
  restoreSpec,
  getSpecSource,
} from '../db/index.js';
import { buildHierarchyReport } from '../lib/hierarchy-report.js';
import { logger } from '../lib/logger.js';

// A project copy is the wrong target for spec withdrawal/restore (ADR-030) —
// those operate on library masters. Withdraw steers the caller to the membership
// endpoint; restore notes the master-only scope. Shared 409 messages.
const PROJECT_COPY_WITHDRAW =
  'spec is a project copy — remove it via DELETE /projects/:id/specs/:specId';
const PROJECT_COPY_RESTORE = 'spec is a project copy — withdrawal applies only to library masters';

export async function getSpecHandler(req: Request, res: Response): Promise<void> {
  const id = parsePathUuid(req, res, 'spec id');
  if (id === null) return;
  try {
    const result = await getSpecTree(id);
    if (!result) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    // Merge the style-source association in as a sibling field (#138). A separate
    // query keeps getSpecTree untouched (owned by a parallel PR); styleSource is
    // { templateId, templateName } | null. onboardingStatus (#139) is surfaced the
    // same way: 'review' | 'active'.
    // A withdrawn master (ADR-030) is still GET-able with its tombstone surfaced
    // (null when active), so lineage/history resolves. Same sibling-field pattern.
    const [styleSource, onboardingStatus, withdrawnAt] = await Promise.all([
      getSpecStyleSource(id),
      getOnboardingStatus(id),
      getSpecWithdrawnAt(id),
    ]);
    res.status(200).json({
      success: true,
      data: { ...result.tree, styleSource, onboardingStatus, withdrawnAt },
    });
  } catch (err) {
    logger.error({ err }, 'get spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getSpecLineageHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    const lineage = await getSpecLineage(idResult.data);
    if (!lineage) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: lineage });
  } catch (err) {
    logger.error({ err }, 'get spec lineage failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getHierarchyReportHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    const result = await getSpecTree(idResult.data);
    if (!result) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    const source = await getSpecSource(idResult.data);
    const report = buildHierarchyReport(result.tree, source);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    logger.error({ err }, 'get hierarchy report failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function updateSpecHandler(req: Request, res: Response): Promise<void> {
  const id = parsePathUuid(req, res, 'spec id');
  if (id === null) return;
  try {
    const body = req.body as { readonly title?: string; readonly section?: string };
    const spec = await updateSpec(id, body);
    if (!spec) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: spec });
  } catch (err) {
    logger.error({ err }, 'update spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function withdrawSpecHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    // Idempotent: a re-withdraw returns the EXISTING withdrawnAt (ADR-030).
    const outcome = await withdrawSpec(idResult.data);
    if (outcome.kind === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    if (outcome.kind === 'project-copy') {
      res.status(409).json({ success: false, error: PROJECT_COPY_WITHDRAW });
      return;
    }
    res
      .status(200)
      .json({ success: true, data: { specId: outcome.specId, withdrawnAt: outcome.withdrawnAt } });
  } catch (err) {
    logger.error({ err }, 'withdraw spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function restoreSpecHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    // Idempotent: restoring an already-active master is a 200 no-op (ADR-030).
    const outcome = await restoreSpec(idResult.data);
    if (outcome.kind === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    if (outcome.kind === 'project-copy') {
      res.status(409).json({ success: false, error: PROJECT_COPY_RESTORE });
      return;
    }
    res.status(200).json({ success: true, data: { specId: outcome.specId } });
  } catch (err) {
    logger.error({ err }, 'restore spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
