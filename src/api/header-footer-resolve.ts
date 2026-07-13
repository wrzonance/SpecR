import { z } from 'zod';
import type { Request, Response } from 'express';
import { resolveHeaderFooterConfig } from '../db/index.js';
import type { ResolveHeaderFooterConfigInput } from '../db/index.js';
import { logger } from '../lib/logger.js';

const UUID_SCHEMA = z.uuid();

type ResolveScopeKind = 'project' | 'package' | 'revision';

interface ResolveScopeMeta {
  readonly paramLabel: string;
  readonly toResolveInput: (id: string) => ResolveHeaderFooterConfigInput;
}

// Dispatch table mirroring SCOPE_META in header-footer.ts — the resolve
// endpoint only ever anchors on project/package/revision (client is not a
// resolution context; resolveHeaderFooterConfig rejects it upstream).
const RESOLVE_SCOPE_META: Record<ResolveScopeKind, ResolveScopeMeta> = {
  project: { paramLabel: 'project', toResolveInput: (id) => ({ projectId: id }) },
  package: { paramLabel: 'package', toResolveInput: (id) => ({ packageId: id }) },
  revision: { paramLabel: 'revision', toResolveInput: (id) => ({ revisionId: id }) },
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

// "Core" suffix avoids shadowing the imported db-layer resolveHeaderFooterConfig
// (same pattern as deleteHeaderFooterConfigCore in header-footer.ts).
async function resolveHeaderFooterConfigCore(
  req: Request,
  res: Response,
  kind: ResolveScopeKind
): Promise<void> {
  const meta = RESOLVE_SCOPE_META[kind];
  const id = parseScopeId(req, res, meta.paramLabel);
  if (!id) return;
  try {
    const resolved = await resolveHeaderFooterConfig(meta.toResolveInput(id));
    if (!resolved) {
      res.status(404).json({ success: false, error: `${meta.paramLabel} not found` });
      return;
    }
    // Returned verbatim — ResolvedHeaderFooterConfig already carries provenance
    // via context + layers (the winning scope is layers[layers.length - 1].scope);
    // no reshaping and no invented winningScope field.
    res.status(200).json({ success: true, data: resolved });
  } catch (err) {
    logger.error({ err }, 'resolve header/footer config failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function resolveProjectHeaderFooterHandler(
  req: Request,
  res: Response
): Promise<void> {
  await resolveHeaderFooterConfigCore(req, res, 'project');
}

export async function resolvePackageHeaderFooterHandler(
  req: Request,
  res: Response
): Promise<void> {
  await resolveHeaderFooterConfigCore(req, res, 'package');
}

export async function resolveRevisionHeaderFooterHandler(
  req: Request,
  res: Response
): Promise<void> {
  await resolveHeaderFooterConfigCore(req, res, 'revision');
}
