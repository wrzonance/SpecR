import { z } from 'zod';
import {
  findProjectById,
  updateProject,
  softDeleteProject,
  restoreProject,
  pool,
} from '../db/index.js';
import type { UpdateProjectInput } from '../db/index.js';
import { SectionNumberFormatSchema } from '../lib/section-number.js';
import { logger } from '../lib/logger.js';
import { toolError, type ToolResult } from './handlers.js';

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const ProjectIdArgs = z.object({ projectId: z.uuid() });

export async function handleGetProject(args: unknown): Promise<ToolResult> {
  const parsed = ProjectIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid get_project input: projectId must be a UUID');
  try {
    const project = await findProjectById(parsed.data.projectId, pool);
    if (!project) return toolError(`Project not found: id=${parsed.data.projectId}`);
    return ok(project);
  } catch (err) {
    logger.error({ err }, 'mcp tool get_project failed');
    return toolError('Internal error — project read failed');
  }
}

const UpdateProjectArgs = z
  .object({
    projectId: z.uuid(),
    name: z.string().min(1).optional(),
    sectionNumberFormat: SectionNumberFormatSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.sectionNumberFormat !== undefined, {
    message: 'at least one of name or sectionNumberFormat is required',
  });

export async function handleUpdateProject(args: unknown): Promise<ToolResult> {
  const parsed = UpdateProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      `invalid update_project input: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }
  const { projectId, name, sectionNumberFormat } = parsed.data;
  const input: UpdateProjectInput = {
    ...(name !== undefined ? { name } : {}),
    ...(sectionNumberFormat !== undefined ? { sectionNumberFormat } : {}),
  };
  try {
    const updated = await updateProject(projectId, input, pool);
    if (!updated) return toolError(`Project not found: id=${projectId}`);
    return ok(updated);
  } catch (err) {
    logger.error({ err }, 'mcp tool update_project failed');
    return toolError('Internal error — project update failed');
  }
}

const DeleteProjectArgs = z.object({ projectId: z.uuid(), deletedBy: z.string().min(1) });

export async function handleDeleteProject(args: unknown): Promise<ToolResult> {
  const parsed = DeleteProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid delete_project input: projectId (UUID) and deletedBy (non-empty) are required'
    );
  }
  try {
    // Soft delete (ADR-031): idempotent — re-deleting returns the existing tombstone.
    const tombstone = await softDeleteProject(parsed.data.projectId, parsed.data.deletedBy, pool);
    if (!tombstone) return toolError(`Project not found: id=${parsed.data.projectId}`);
    return ok(tombstone);
  } catch (err) {
    logger.error({ err }, 'mcp tool delete_project failed');
    return toolError('Internal error — project deletion failed');
  }
}

export async function handleRestoreProject(args: unknown): Promise<ToolResult> {
  const parsed = ProjectIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid restore_project input: projectId must be a UUID');
  try {
    // Idempotent: restoring a non-deleted project is a no-op success (ADR-031).
    const restored = await restoreProject(parsed.data.projectId, pool);
    if (!restored) return toolError(`Project not found: id=${parsed.data.projectId}`);
    return ok(restored);
  } catch (err) {
    logger.error({ err }, 'mcp tool restore_project failed');
    return toolError('Internal error — project restore failed');
  }
}
