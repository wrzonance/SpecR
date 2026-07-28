import { z } from 'zod';
import {
  createCheckpoint,
  listCheckpoints,
  getCheckpointById,
  getSpecPendingSummary,
  getProjectPendingSummary,
  resolveOrCreateUserByLabel,
  CheckpointScopeNotFoundError,
  SpecNotFoundError,
  ProjectNotFoundError,
} from '../db/index.js';
import type { CheckpointScope } from '../db/index.js';
import { CreateCheckpointBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { ok, toolError, type ToolResult } from './handlers.js';
import type { ToolError } from './tool-result.js';

// ADR-052 D3/D4/D9 (issue #380, task 10) — MCP surface for checkpoints and
// pending-change summaries. Four tools cover the seven REST reads/writes
// (createSpecCheckpoint/createProjectCheckpoint, listSpecCheckpoints/
// listProjectCheckpoints, getCheckpoint, getSpecPendingSummary/
// getProjectPendingSummary): one tool per REST-operation PAIR, exactly one of
// specId/projectId selecting scope — the get_reference_graph precedent (#447,
// reference-graph-handler.ts) for a single agent-facing tool spanning two
// REST routes that differ only by scope. Per-paragraph reject (`PATCH
// /specs/{id}/paragraphs/{nodeId}/reject`) is a distinct write-tier tool
// deferred to a dedicated follow-up (see contract-map.ts MCP_UNEXPOSED).

export const CheckpointScopeShape = {
  specId: z.uuid().optional().describe('Spec UUID — spec-scoped checkpoint'),
  projectId: z
    .uuid()
    .optional()
    .describe('Project UUID — project-scoped checkpoint (seals every spec it owns)'),
};

// Spread CreateCheckpointBodySchema.shape (name + actorLabel — REST's exact
// contract) rather than re-declaring the fields, so the two surfaces cannot
// drift on trimming/length rules.
export const CreateCheckpointShape = {
  ...CheckpointScopeShape,
  ...CreateCheckpointBodySchema.shape,
};
const CheckpointScopeArgs = z.object(CheckpointScopeShape);

export const CheckpointIdShape = {
  checkpointId: z.uuid().describe('Checkpoint UUID (from create_checkpoint or list_checkpoints)'),
};
const CheckpointIdArgs = z.object(CheckpointIdShape);

export const PendingSummaryShape = {
  ...CheckpointScopeShape,
  packageId: z
    .uuid()
    .optional()
    .describe(
      'Project scope only — echoed back for the caller’s own issuance-deadline framing, never scopes the query'
    ),
};
const PendingSummaryArgs = z.object(PendingSummaryShape);

interface CheckpointScopeResult {
  readonly scope: CheckpointScope;
  readonly scopeId: string;
}

function issues(err: z.ZodError): string {
  return err.issues.map((issue) => issue.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

/** Exactly one of specId/projectId picks the scope — neither or both is a tool
 *  error, mirroring get_reference_graph's resolveScope (reference-graph-handler.ts). */
function resolveCheckpointScope(
  specId: string | undefined,
  projectId: string | undefined
): CheckpointScopeResult | ToolError {
  if (specId !== undefined && projectId === undefined) return { scope: 'spec', scopeId: specId };
  if (projectId !== undefined && specId === undefined) {
    return { scope: 'project', scopeId: projectId };
  }
  return toolError('Provide exactly one of specId or projectId');
}

export async function handleCreateCheckpoint(args: unknown): Promise<ToolResult> {
  const owner = CheckpointScopeArgs.safeParse(args);
  if (!owner.success) return toolError(`invalid create_checkpoint input: ${issues(owner.error)}`);
  const body = CreateCheckpointBodySchema.safeParse(args);
  if (!body.success) return toolError(`invalid create_checkpoint input: ${issues(body.error)}`);
  const scope = resolveCheckpointScope(owner.data.specId, owner.data.projectId);
  if ('isError' in scope) return scope;
  try {
    const user = await resolveOrCreateUserByLabel(body.data.actorLabel);
    const checkpoint = await createCheckpoint({
      name: body.data.name,
      scope: scope.scope,
      scopeId: scope.scopeId,
      userId: user.id,
    });
    return ok(checkpoint);
  } catch (err) {
    if (err instanceof CheckpointScopeNotFoundError) return toolError(err.message);
    return internalError(err, 'create_checkpoint');
  }
}

export async function handleListCheckpoints(args: unknown): Promise<ToolResult> {
  const parsed = CheckpointScopeArgs.safeParse(args);
  if (!parsed.success) return toolError(`invalid list_checkpoints input: ${issues(parsed.error)}`);
  const scope = resolveCheckpointScope(parsed.data.specId, parsed.data.projectId);
  if ('isError' in scope) return scope;
  try {
    return ok(await listCheckpoints(scope.scope, scope.scopeId));
  } catch (err) {
    return internalError(err, 'list_checkpoints');
  }
}

export async function handleGetCheckpoint(args: unknown): Promise<ToolResult> {
  const parsed = CheckpointIdArgs.safeParse(args);
  if (!parsed.success) return toolError(`invalid get_checkpoint input: ${issues(parsed.error)}`);
  try {
    const checkpoint = await getCheckpointById(parsed.data.checkpointId);
    return checkpoint
      ? ok(checkpoint)
      : toolError(`checkpoint not found: id=${parsed.data.checkpointId}`);
  } catch (err) {
    return internalError(err, 'get_checkpoint');
  }
}

async function fetchPendingSummary(
  scope: CheckpointScopeResult,
  packageId: string | undefined
): Promise<ToolResult> {
  if (scope.scope === 'spec') return ok(await getSpecPendingSummary(scope.scopeId));
  return ok(await getProjectPendingSummary(scope.scopeId, packageId));
}

export async function handleGetPendingSummary(args: unknown): Promise<ToolResult> {
  const parsed = PendingSummaryArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid get_pending_summary input: ${issues(parsed.error)}`);
  }
  const { specId, projectId, packageId } = parsed.data;
  if (specId !== undefined && packageId !== undefined) {
    return toolError('packageId only applies when projectId is provided');
  }
  const scope = resolveCheckpointScope(specId, projectId);
  if ('isError' in scope) return scope;
  try {
    return await fetchPendingSummary(scope, packageId);
  } catch (err) {
    if (err instanceof SpecNotFoundError || err instanceof ProjectNotFoundError) {
      return toolError(err.message);
    }
    return internalError(err, 'get_pending_summary');
  }
}
