import type { Request, Response } from 'express';
import {
  createPackageRevision,
  getPackageRevision,
  listPackageRevisions,
  PackageNotFoundError,
  RevisionNomenclatureValidationError,
  RevisionParentValidationError,
  SnapshotValidationError,
  pool,
} from '../db/index.js';
import type { CreateRevisionBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

/** POST /packages/:id/revisions — issue an immutable snapshot (ADR-015 D5).
 *  Returns a summary; the frozen trees are read via GET /revisions/:id. */
export async function createRevisionHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing package id' });
    return;
  }
  try {
    const body = req.body as CreateRevisionBody;
    const revision = await createPackageRevision(id, body, pool);
    res.status(201).json({ success: true, data: revision });
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    // Same-shaped "unprocessable input" rejections — a member tree that can't be
    // snapshotted losslessly, a type outside the project's nomenclature profile, or
    // a parentRevisionId that fails a custody invariant (not found, cross-package,
    // nesting depth > 1) — all map to 422 with the error's own message. Merged into
    // one instanceof chain (not one `if` per class) to keep cognitive-complexity
    // under the repo's ESLint cap as the error surface grows.
    if (
      err instanceof SnapshotValidationError ||
      err instanceof RevisionNomenclatureValidationError ||
      err instanceof RevisionParentValidationError
    ) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    const mapped = pgErrorToHttp(err, {
      '23505': 'revision already exists for this package',
    });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'create revision failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

/** GET /packages/:id/revisions — the package's issuance timeline as light
 *  summaries, ordered by sortOrder. Metadata only; frozen trees are read per
 *  revision via GET /revisions/:id. 404 when the package is unknown. */
export async function listPackageRevisionsHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing package id' });
    return;
  }
  try {
    const revisions = await listPackageRevisions(id, pool);
    if (revisions === null) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    res.status(200).json({ success: true, data: revisions });
  } catch (err) {
    logger.error({ err }, 'list package revisions failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

/** GET /revisions/:id — frozen trees in membership order, validated on read. */
export async function getRevisionHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing revision id' });
    return;
  }
  try {
    const revision = await getPackageRevision(id, pool);
    if (revision === null) {
      res.status(404).json({ success: false, error: 'revision not found' });
      return;
    }
    res.status(200).json({ success: true, data: revision });
  } catch (err) {
    // SnapshotValidationError on read is a data-integrity failure, not a
    // client error — surface as 500 without leaking validation internals.
    logger.error({ err }, 'get revision failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
