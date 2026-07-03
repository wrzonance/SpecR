import { z } from 'zod';
import {
  listRevisionNomenclatureProfiles,
  findProjectById,
  getRevisionNomenclatureForProject,
  upsertProjectRevisionNomenclature,
  findRevisionNomenclatureProfileById,
  deleteProjectRevisionNomenclature,
  pool,
} from '../db/index.js';
import {
  PutRevisionNomenclatureBodySchema,
  CloneRevisionNomenclatureBodySchema,
} from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Shapes exported so the tools advertise exactly what the handlers validate, reusing the
// REST body schemas (one source of truth).
export const RevisionNomenclatureProjectShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
};
const ProjectIdArgs = z.object(RevisionNomenclatureProjectShape);

export const SetRevisionNomenclatureShape = {
  ...RevisionNomenclatureProjectShape,
  ...PutRevisionNomenclatureBodySchema.shape,
};
const SetArgs = z.object(SetRevisionNomenclatureShape);

export const CloneRevisionNomenclatureShape = {
  ...RevisionNomenclatureProjectShape,
  ...CloneRevisionNomenclatureBodySchema.shape,
};
const CloneArgs = z.object(CloneRevisionNomenclatureShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

async function requireProjectOrError(projectId: string): Promise<ToolResult | null> {
  const project = await findProjectById(projectId, pool);
  if (!project) return toolError(`project not found: id=${projectId}`);
  return null;
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleListRevisionNomenclatureProfiles(): Promise<ToolResult> {
  try {
    return ok(await listRevisionNomenclatureProfiles(pool));
  } catch (err) {
    return internalError(err, 'list_revision_nomenclature_profiles');
  }
}

export async function handleGetProjectRevisionNomenclature(args: unknown): Promise<ToolResult> {
  const parsed = ProjectIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_project_revision_nomenclature input: projectId must be a UUID');
  }
  try {
    const libErr = await requireProjectOrError(parsed.data.projectId);
    if (libErr) return libErr;
    const profile = await getRevisionNomenclatureForProject(parsed.data.projectId, pool);
    if (!profile) return toolError('no revision nomenclature available');
    // projectId === null → the project inherits the built-in default profile.
    return ok({ ...profile, inherited: profile.projectId === null });
  } catch (err) {
    return internalError(err, 'get_project_revision_nomenclature');
  }
}

export async function handleSetProjectRevisionNomenclature(args: unknown): Promise<ToolResult> {
  const parsed = SetArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_project_revision_nomenclature input: ${issues(parsed.error)}`);
  }
  const { projectId, name, types } = parsed.data;
  try {
    const libErr = await requireProjectOrError(projectId);
    if (libErr) return libErr;
    return ok(await upsertProjectRevisionNomenclature(projectId, name, types, pool));
  } catch (err) {
    return internalError(err, 'set_project_revision_nomenclature');
  }
}

export async function handleCloneProjectRevisionNomenclature(args: unknown): Promise<ToolResult> {
  const parsed = CloneArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid clone_project_revision_nomenclature input: ${issues(parsed.error)}`);
  }
  const { projectId, sourceId } = parsed.data;
  try {
    const libErr = await requireProjectOrError(projectId);
    if (libErr) return libErr;
    const source = await findRevisionNomenclatureProfileById(sourceId, pool);
    if (!source) return toolError(`source revision nomenclature not found: id=${sourceId}`);
    return ok(await upsertProjectRevisionNomenclature(projectId, source.name, source.types, pool));
  } catch (err) {
    return internalError(err, 'clone_project_revision_nomenclature');
  }
}

export async function handleClearProjectRevisionNomenclature(args: unknown): Promise<ToolResult> {
  const parsed = ProjectIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid clear_project_revision_nomenclature input: projectId must be a UUID');
  }
  try {
    const libErr = await requireProjectOrError(parsed.data.projectId);
    if (libErr) return libErr;
    // Clears the project override so it falls back to the built-in default (reversible).
    await deleteProjectRevisionNomenclature(parsed.data.projectId, pool);
    return ok({ projectId: parsed.data.projectId, cleared: true });
  } catch (err) {
    return internalError(err, 'clear_project_revision_nomenclature');
  }
}
