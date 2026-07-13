import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  deleteHeaderFooterConfig,
  findHeaderFooterConfig,
  findLibraryById,
  HeaderFooterScopeError,
  HeaderFooterValidationError,
  upsertHeaderFooterConfig,
} from '../db/index.js';
import type { HeaderFooterScopeInput } from '../db/index.js';
import type { HeaderFooterComposition } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

const UUID_SCHEMA = z.uuid();

type ScopeKind = 'client' | 'project' | 'package' | 'revision';

interface ScopeMeta {
  readonly paramLabel: string;
  readonly toScopeInput: (id: string) => HeaderFooterScopeInput;
  readonly responseIdField: 'libraryId' | 'projectId' | 'packageId' | 'revisionId';
}

// Dispatch table shared by all three CRUD verbs — one entry per scope kind,
// keeping the four scopes' only real difference (which column they key on)
// out of the get/put/delete bodies below.
const SCOPE_META: Record<ScopeKind, ScopeMeta> = {
  client: {
    paramLabel: 'library',
    toScopeInput: (id) => ({ clientLibraryId: id }),
    responseIdField: 'libraryId',
  },
  project: {
    paramLabel: 'project',
    toScopeInput: (id) => ({ projectId: id }),
    responseIdField: 'projectId',
  },
  package: {
    paramLabel: 'package',
    toScopeInput: (id) => ({ packageId: id }),
    responseIdField: 'packageId',
  },
  revision: {
    paramLabel: 'revision',
    toScopeInput: (id) => ({ revisionId: id }),
    responseIdField: 'revisionId',
  },
};

// Parse the :id path param, replying 400 on a malformed UUID.
function parseScopeId(req: Request, res: Response, label: string): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: `invalid ${label} id` });
    return null;
  }
  return result.data;
}

// Client scope is the one kind whose anchor (a library) has no other route
// that already 404s on its absence, and whose DB-layer existence check
// (assertClientLibrary) throws the same error class for "not found" as it
// does for "wrong tier" — so without this pre-flight, a write against a
// missing library id would incorrectly surface as 422, not 404.
async function requireClientLibrary(libraryId: string, res: Response): Promise<boolean> {
  const library = await findLibraryById(libraryId);
  if (!library) {
    res.status(404).json({ success: false, error: 'library not found' });
    return false;
  }
  return true;
}

// HeaderFooterValidationError/HeaderFooterScopeError are semantic write
// rejections (422). A foreign-key violation on project/package/revision id
// (client scope is pre-checked above) is the write's only other 404 source.
// Anything else is unexpected — log with context, respond without leaking it.
function mapWriteError(err: unknown, res: Response): void {
  if (err instanceof HeaderFooterValidationError || err instanceof HeaderFooterScopeError) {
    res.status(422).json({ success: false, error: err.message });
    return;
  }
  const mapped = pgErrorToHttp(err, { '23503': 'referenced scope not found' });
  if (mapped) {
    res.status(mapped.status).json({ success: false, error: mapped.error });
    return;
  }
  logger.error({ err }, 'header/footer config write failed');
  res.status(500).json({ success: false, error: 'internal server error' });
}

async function getHeaderFooterConfig(req: Request, res: Response, kind: ScopeKind): Promise<void> {
  const meta = SCOPE_META[kind];
  const id = parseScopeId(req, res, meta.paramLabel);
  if (!id) return;
  try {
    const found = await findHeaderFooterConfig(meta.toScopeInput(id));
    if (!found) {
      res.status(404).json({ success: false, error: 'header/footer config not found' });
      return;
    }
    res.status(200).json({ success: true, data: found });
  } catch (err) {
    logger.error({ err }, 'get header/footer config failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

async function putHeaderFooterConfig(req: Request, res: Response, kind: ScopeKind): Promise<void> {
  const meta = SCOPE_META[kind];
  const id = parseScopeId(req, res, meta.paramLabel);
  if (!id) return;
  // Shape is already validated upstream by validateBody(HeaderFooterCompositionSchema).
  const body = req.body as HeaderFooterComposition;
  try {
    if (kind === 'client' && !(await requireClientLibrary(id, res))) return;
    const config = await upsertHeaderFooterConfig(meta.toScopeInput(id), body);
    res.status(200).json({ success: true, data: config });
  } catch (err) {
    mapWriteError(err, res);
  }
}

async function deleteHeaderFooterConfigCore(
  req: Request,
  res: Response,
  kind: ScopeKind
): Promise<void> {
  const meta = SCOPE_META[kind];
  const id = parseScopeId(req, res, meta.paramLabel);
  if (!id) return;
  try {
    if (kind === 'client' && !(await requireClientLibrary(id, res))) return;
    const deleted = await deleteHeaderFooterConfig(meta.toScopeInput(id));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'header/footer config not found' });
      return;
    }
    res.status(200).json({ success: true, data: { [meta.responseIdField]: id } });
  } catch (err) {
    mapWriteError(err, res);
  }
}

export async function getLibraryHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await getHeaderFooterConfig(req, res, 'client');
}

export async function putLibraryHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await putHeaderFooterConfig(req, res, 'client');
}

export async function deleteLibraryHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await deleteHeaderFooterConfigCore(req, res, 'client');
}

export async function getProjectHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await getHeaderFooterConfig(req, res, 'project');
}

export async function putProjectHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await putHeaderFooterConfig(req, res, 'project');
}

export async function deleteProjectHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await deleteHeaderFooterConfigCore(req, res, 'project');
}

export async function getPackageHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await getHeaderFooterConfig(req, res, 'package');
}

export async function putPackageHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await putHeaderFooterConfig(req, res, 'package');
}

export async function deletePackageHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await deleteHeaderFooterConfigCore(req, res, 'package');
}

export async function getRevisionHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await getHeaderFooterConfig(req, res, 'revision');
}

export async function putRevisionHeaderFooterHandler(req: Request, res: Response): Promise<void> {
  await putHeaderFooterConfig(req, res, 'revision');
}

export async function deleteRevisionHeaderFooterHandler(
  req: Request,
  res: Response
): Promise<void> {
  await deleteHeaderFooterConfigCore(req, res, 'revision');
}
