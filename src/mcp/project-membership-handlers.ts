import { z } from 'zod';
import {
  addSectionToProject,
  removeSectionFromProject,
  setProjectSources,
  findProjectById,
  InvalidSourceLibraryError,
  ProjectNotFoundError,
  SectionUnresolvedError,
  pool,
} from '../db/index.js';
import { AddSectionToProjectBodySchema, SetProjectSourcesBodySchema } from '../ast/index.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Shapes reuse the REST body schemas via .shape (one source of truth), plus path params.
export const AddProjectSectionShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
  ...AddSectionToProjectBodySchema.shape,
};
const AddArgs = z.object(AddProjectSectionShape);

export const RemoveProjectSectionShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
  specId: z
    .uuid()
    .describe('Project spec (clone) UUID to remove — from list_library_specs/get_spec'),
  force: z
    .boolean()
    .describe('Delete even if the section carries project edits (destroys those edits)')
    .optional(),
};
const RemoveArgs = z.object(RemoveProjectSectionShape);

export const SetProjectSourcesShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
  ...SetProjectSourcesBodySchema.shape,
};
const SetSourcesArgs = z.object(SetProjectSourcesShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleAddProjectSection(args: unknown): Promise<ToolResult> {
  const parsed = AddArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid add_project_section input: ${issues(parsed.error)}`);
  }
  const { projectId, section } = parsed.data;
  try {
    return ok(await addSectionToProject(projectId, section, pool));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return toolError(`project not found: id=${projectId}`);
    if (err instanceof SectionUnresolvedError) return toolError(err.message);
    if (getPgCode(err) === '23505') return toolError('section already in project');
    return internalError(err, 'add_project_section');
  }
}

export async function handleRemoveProjectSection(args: unknown): Promise<ToolResult> {
  const parsed = RemoveArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid remove_project_section input: ${issues(parsed.error)}`);
  }
  const { projectId, specId, force } = parsed.data;
  try {
    const outcome = await removeSectionFromProject(projectId, specId, force ?? false, pool);
    if (outcome === 'not-found') return toolError('spec not in project');
    if (outcome === 'edited') {
      return toolError('section has project edits — set force=true to delete them');
    }
    if (outcome === 'in-package') {
      return toolError('section belongs to a design package — remove it from the package first');
    }
    return ok({ projectId, specId, removed: true });
  } catch (err) {
    return internalError(err, 'remove_project_section');
  }
}

export async function handleSetProjectSources(args: unknown): Promise<ToolResult> {
  const parsed = SetSourcesArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_project_sources input: ${issues(parsed.error)}`);
  }
  const { projectId, sourceLibraryIds } = parsed.data;
  try {
    const project = await findProjectById(projectId, pool);
    if (!project) return toolError(`project not found: id=${projectId}`);
    const sources = await setProjectSources(projectId, sourceLibraryIds, pool);
    return ok({ projectId, sources });
  } catch (err) {
    if (err instanceof InvalidSourceLibraryError) return toolError(err.message);
    return internalError(err, 'set_project_sources');
  }
}
