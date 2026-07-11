import { z } from 'zod';
import {
  findLibraryById,
  findProjectById,
  listDisciplines,
  listProjectSpecs,
  replaceLibraryDisciplineRules,
  clearLibraryDisciplineRules,
  DisciplineNotFoundError,
  pool,
} from '../db/index.js';
import { SetDisciplinesBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Shapes are exported so discipline-tools.ts advertises the SAME field constraints the
// handlers validate — one source of truth (mirrors the convention/library-management tools).

export const ListDisciplinesShape = {
  libraryId: z
    .uuid()
    .describe('Resolve the mapping for this library (falls back to the built-in default)')
    .optional(),
};
const ListDisciplinesArgs = z.object(ListDisciplinesShape);

export const SetLibraryDisciplinesShape = {
  libraryId: z.uuid().describe('Library UUID (from list_libraries)'),
  rules: SetDisciplinesBodySchema.shape.rules.describe(
    'Complete replacement rule set — each maps an inclusive CSI division range to a ' +
      'discipline key (from list_disciplines); ranges must not overlap'
  ),
};
const SetLibraryDisciplinesArgs = z.object(SetLibraryDisciplinesShape);

export const ClearLibraryDisciplinesShape = {
  libraryId: z.uuid().describe('Library UUID (from list_libraries)'),
};
const ClearLibraryDisciplinesArgs = z.object(ClearLibraryDisciplinesShape);

export const ListProjectSpecsShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
  discipline: z
    .string()
    .describe('Keep only specs resolving to this discipline key (from list_disciplines)')
    .optional(),
};
const ListProjectSpecsArgs = z.object(ListProjectSpecsShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleListDisciplines(args: unknown): Promise<ToolResult> {
  const parsed = ListDisciplinesArgs.safeParse(args);
  if (!parsed.success) return toolError(`invalid list_disciplines input: ${issues(parsed.error)}`);
  const { libraryId } = parsed.data;
  try {
    if (libraryId !== undefined && !(await findLibraryById(libraryId))) {
      return toolError(`library not found: id=${libraryId}`);
    }
    const resolved = await listDisciplines(libraryId);
    return ok(resolved.disciplines);
  } catch (err) {
    return internalError(err, 'list_disciplines');
  }
}

export async function handleSetLibraryDisciplines(args: unknown): Promise<ToolResult> {
  const parsed = SetLibraryDisciplinesArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_library_disciplines input: ${issues(parsed.error)}`);
  }
  const { libraryId, rules } = parsed.data;
  try {
    if (!(await findLibraryById(libraryId))) return toolError(`library not found: id=${libraryId}`);
    await replaceLibraryDisciplineRules(libraryId, rules);
    const resolved = await listDisciplines(libraryId);
    return ok(resolved.disciplines);
  } catch (err) {
    if (err instanceof DisciplineNotFoundError) return toolError(err.message);
    return internalError(err, 'set_library_disciplines');
  }
}

export async function handleClearLibraryDisciplines(args: unknown): Promise<ToolResult> {
  const parsed = ClearLibraryDisciplinesArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid clear_library_disciplines input: ${issues(parsed.error)}`);
  }
  const { libraryId } = parsed.data;
  try {
    if (!(await findLibraryById(libraryId))) return toolError(`library not found: id=${libraryId}`);
    const cleared = await clearLibraryDisciplineRules(libraryId);
    return ok({ cleared });
  } catch (err) {
    return internalError(err, 'clear_library_disciplines');
  }
}

export async function handleListProjectSpecs(args: unknown): Promise<ToolResult> {
  const parsed = ListProjectSpecsArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid list_project_specs input: ${issues(parsed.error)}`);
  }
  const { projectId, discipline } = parsed.data;
  try {
    if (!(await findProjectById(projectId, pool))) {
      return toolError(`project not found: id=${projectId}`);
    }
    return ok(
      await listProjectSpecs(projectId, discipline !== undefined ? { discipline } : {}, pool)
    );
  } catch (err) {
    return internalError(err, 'list_project_specs');
  }
}
