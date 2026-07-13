import { z } from 'zod';
import { resolveHeaderFooterConfig, HeaderFooterScopeError } from '../db/index.js';
import type { ResolveHeaderFooterConfigInput } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';
import {
  ProjectHeaderFooterShape,
  PackageHeaderFooterShape,
  RevisionHeaderFooterShape,
} from './header-footer-handlers.js';

// Re-exported (not re-declared) — the resolve endpoint anchors on the exact
// same project/package/revision ids as the CRUD tools, so the arg shape is
// identical. Client scope is not a resolution context (resolveHeaderFooterConfig
// rejects it upstream), hence no ResolveLibraryHeaderFooterShape.
export const ResolveProjectHeaderFooterShape = ProjectHeaderFooterShape;
export const ResolvePackageHeaderFooterShape = PackageHeaderFooterShape;
export const ResolveRevisionHeaderFooterShape = RevisionHeaderFooterShape;

type ResolveScopeKind = 'project' | 'package' | 'revision';

interface ResolveScopeMeta {
  readonly toResolveInput: (id: string) => ResolveHeaderFooterConfigInput;
}

// Dispatch table mirroring SCOPE_META in header-footer-handlers.ts — the
// resolve tools only ever anchor on project/package/revision.
const RESOLVE_SCOPE_META: Record<ResolveScopeKind, ResolveScopeMeta> = {
  project: { toResolveInput: (id) => ({ projectId: id }) },
  package: { toResolveInput: (id) => ({ packageId: id }) },
  revision: { toResolveInput: (id) => ({ revisionId: id }) },
};

const ProjectArgs = z.object(ResolveProjectHeaderFooterShape);
const PackageArgs = z.object(ResolvePackageHeaderFooterShape);
const RevisionArgs = z.object(ResolveRevisionHeaderFooterShape);

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

async function runResolveHeaderFooter(
  kind: ResolveScopeKind,
  id: string,
  tool: string
): Promise<ToolResult> {
  try {
    const resolved = await resolveHeaderFooterConfig(RESOLVE_SCOPE_META[kind].toResolveInput(id));
    if (!resolved) return toolError(`${kind} not found`);
    // Returned verbatim — ResolvedHeaderFooterConfig already carries provenance
    // via context + layers (the winning scope is layers[layers.length - 1].scope);
    // no reshaping and no invented winningScope field.
    return ok(resolved);
  } catch (err) {
    if (err instanceof HeaderFooterScopeError) return toolError(err.message);
    return internalError(err, tool);
  }
}

export async function handleResolveProjectHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = ProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid resolve_project_header_footer input: projectId must be a UUID');
  }
  return runResolveHeaderFooter('project', parsed.data.projectId, 'resolve_project_header_footer');
}

export async function handleResolvePackageHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = PackageArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid resolve_package_header_footer input: packageId must be a UUID');
  }
  return runResolveHeaderFooter('package', parsed.data.packageId, 'resolve_package_header_footer');
}

export async function handleResolveRevisionHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = RevisionArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid resolve_revision_header_footer input: revisionId must be a UUID');
  }
  return runResolveHeaderFooter(
    'revision',
    parsed.data.revisionId,
    'resolve_revision_header_footer'
  );
}
