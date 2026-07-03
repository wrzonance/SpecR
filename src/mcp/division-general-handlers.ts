import { z } from 'zod';
import {
  getLibraryDivisionGeneralSpec,
  getProjectDivisionGeneralSpec,
  setLibraryDivisionGeneralSpec,
  setProjectDivisionGeneralSpec,
  DivisionGeneralOwnerNotFoundError,
  DivisionGeneralSpecNotInScopeError,
} from '../db/index.js';
import type { DivisionGeneralSpecResult } from '../db/index.js';
import { SetDivisionGeneralSpecBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// A two-digit CSI division ("07", "27" …), matching the REST DivisionSchema.
const DivisionField = z
  .string()
  .regex(/^\d{2}$/, 'division must be a two-digit CSI division (e.g. "07")')
  .describe('Two-digit CSI division, e.g. "07"');

export const LibraryDivisionShape = {
  libraryId: z.uuid().describe('Library UUID (from list_libraries)'),
  division: DivisionField,
};
const LibraryDivisionArgs = z.object(LibraryDivisionShape);

export const ProjectDivisionShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
  division: DivisionField,
};
const ProjectDivisionArgs = z.object(ProjectDivisionShape);

// The set body is the REST schema's XOR shape: exactly one of generalSpecId or
// status='not_applicable', with optional notes. Spread .shape to advertise the
// fields; the full schema (with its XOR check) validates the body separately.
export const SetLibraryDivisionShape = {
  ...LibraryDivisionShape,
  ...SetDivisionGeneralSpecBodySchema.shape,
};
export const SetProjectDivisionShape = {
  ...ProjectDivisionShape,
  ...SetDivisionGeneralSpecBodySchema.shape,
};

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

// Shared core: fetch the effective general-spec, mapping a missing owner to a
// tool error. (GET auto-resolves — it materializes the exact-section config.)
async function runGet(
  tool: string,
  ownerNotFound: string,
  fetch: () => Promise<DivisionGeneralSpecResult | null>
): Promise<ToolResult> {
  try {
    const result = await fetch();
    if (!result) return toolError(ownerNotFound);
    return ok(result);
  } catch (err) {
    return internalError(err, tool);
  }
}

// Shared core: run a set, mapping the two typed domain errors (unknown owner →
// 404-equivalent; chosen spec not in the division's scope → 422-equivalent).
async function runSet(
  tool: string,
  run: () => Promise<DivisionGeneralSpecResult>
): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (err) {
    if (
      err instanceof DivisionGeneralOwnerNotFoundError ||
      err instanceof DivisionGeneralSpecNotInScopeError
    ) {
      return toolError(err.message);
    }
    return internalError(err, tool);
  }
}

export async function handleGetLibraryGeneralSpec(args: unknown): Promise<ToolResult> {
  const parsed = LibraryDivisionArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid get_library_general_spec input: ${issues(parsed.error)}`);
  }
  const { libraryId, division } = parsed.data;
  return runGet('get_library_general_spec', `library not found: id=${libraryId}`, () =>
    getLibraryDivisionGeneralSpec(libraryId, division)
  );
}

export async function handleGetProjectGeneralSpec(args: unknown): Promise<ToolResult> {
  const parsed = ProjectDivisionArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid get_project_general_spec input: ${issues(parsed.error)}`);
  }
  const { projectId, division } = parsed.data;
  return runGet('get_project_general_spec', `project not found: id=${projectId}`, () =>
    getProjectDivisionGeneralSpec(projectId, division)
  );
}

export async function handleSetLibraryGeneralSpec(args: unknown): Promise<ToolResult> {
  const owner = LibraryDivisionArgs.safeParse(args);
  if (!owner.success) {
    return toolError(`invalid set_library_general_spec input: ${issues(owner.error)}`);
  }
  const body = SetDivisionGeneralSpecBodySchema.safeParse(args);
  if (!body.success) {
    return toolError(`invalid set_library_general_spec input: ${issues(body.error)}`);
  }
  return runSet('set_library_general_spec', () =>
    setLibraryDivisionGeneralSpec(owner.data.libraryId, owner.data.division, body.data)
  );
}

export async function handleSetProjectGeneralSpec(args: unknown): Promise<ToolResult> {
  const owner = ProjectDivisionArgs.safeParse(args);
  if (!owner.success) {
    return toolError(`invalid set_project_general_spec input: ${issues(owner.error)}`);
  }
  const body = SetDivisionGeneralSpecBodySchema.safeParse(args);
  if (!body.success) {
    return toolError(`invalid set_project_general_spec input: ${issues(body.error)}`);
  }
  return runSet('set_project_general_spec', () =>
    setProjectDivisionGeneralSpec(owner.data.projectId, owner.data.division, body.data)
  );
}
