import { z } from 'zod';
import {
  findLibraryById,
  listBuiltInConventions,
  getConventionForLibrary,
  upsertLibraryConvention,
  getBuiltInConvention,
  findConventionById,
  ConventionValidationError,
} from '../db/index.js';
import type { EditingConvention } from '../db/index.js';
import { PutConventionBodySchema, CloneConventionBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Shapes exported so convention-tools.ts advertises exactly what the handlers validate,
// reusing the REST body schemas (one source of truth).
export const ConventionLibraryIdShape = {
  libraryId: z.uuid().describe('Library UUID (from list_libraries)'),
};
const ConventionLibraryIdArgs = z.object(ConventionLibraryIdShape);

export const SetConventionShape = {
  ...ConventionLibraryIdShape,
  ...PutConventionBodySchema.shape,
};
const SetConventionArgs = z.object(SetConventionShape);

export const CloneConventionShape = {
  ...ConventionLibraryIdShape,
  ...CloneConventionBodySchema.shape,
};
const CloneConventionArgs = z.object(CloneConventionShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

// Library existence guard, mirroring the REST requireLibrary → 404.
async function requireLibraryOrError(libraryId: string): Promise<ToolResult | null> {
  const library = await findLibraryById(libraryId);
  if (!library) return toolError(`library not found: id=${libraryId}`);
  return null;
}

// Unsafe-regex write rejection (REST 422) → tool error; else null to fall through.
function conventionWriteError(err: unknown): ToolResult | null {
  if (err instanceof ConventionValidationError) return toolError(err.message);
  return null;
}

export async function handleListConventions(): Promise<ToolResult> {
  try {
    return ok(await listBuiltInConventions());
  } catch (err) {
    logger.error({ err }, 'mcp tool list_conventions failed');
    return toolError('Internal error — list conventions failed');
  }
}

export async function handleGetLibraryConventions(args: unknown): Promise<ToolResult> {
  const parsed = ConventionLibraryIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_library_conventions input: libraryId must be a UUID');
  }
  try {
    const libErr = await requireLibraryOrError(parsed.data.libraryId);
    if (libErr) return libErr;
    const resolved = await getConventionForLibrary(parsed.data.libraryId);
    if (!resolved) return toolError('no convention available');
    // libraryId === null → the library has no profile of its own and inherits the
    // built-in industry default; surface that as an explicit flag.
    return ok({ ...resolved, inherited: resolved.libraryId === null });
  } catch (err) {
    logger.error({ err }, 'mcp tool get_library_conventions failed');
    return toolError('Internal error — get library conventions failed');
  }
}

export async function handleSetLibraryConventions(args: unknown): Promise<ToolResult> {
  const parsed = SetConventionArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_library_conventions input: ${issues(parsed.error)}`);
  }
  const { libraryId, name, rules } = parsed.data;
  try {
    const libErr = await requireLibraryOrError(libraryId);
    if (libErr) return libErr;
    return ok(await upsertLibraryConvention(libraryId, name, rules ?? {}));
  } catch (err) {
    return conventionWriteError(err) ?? internalError(err, 'set_library_conventions');
  }
}

export async function handleCloneConventions(args: unknown): Promise<ToolResult> {
  const parsed = CloneConventionArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid clone_conventions input: ${issues(parsed.error)}`);
  }
  const { libraryId, sourceId } = parsed.data;
  try {
    const libErr = await requireLibraryOrError(libraryId);
    if (libErr) return libErr;
    const source = await resolveCloneSource(sourceId);
    if (!source) return toolError(`source convention not found: id=${sourceId}`);
    return ok(await upsertLibraryConvention(libraryId, source.name, source.rules));
  } catch (err) {
    return conventionWriteError(err) ?? internalError(err, 'clone_conventions');
  }
}

// Resolve a clone source: the built-in default (library_id IS NULL) or any profile by id.
async function resolveCloneSource(sourceId: string): Promise<EditingConvention | null> {
  const builtIn = await getBuiltInConvention();
  if (builtIn && builtIn.id === sourceId) return builtIn;
  return findConventionById(sourceId);
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}
