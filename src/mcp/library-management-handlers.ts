import { z } from 'zod';
import {
  findLibraryById,
  listLibrarySpecs,
  updateLibraryName,
  createClientLibrary,
  ParentLibraryNotFoundError,
  ParentLibraryNotCompanyError,
  DefaultCompanyLibraryError,
} from '../db/index.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Request shapes. The REST bodies (RenameLibraryBody / CreateClientLibraryBody) are
// declared inline in src/api/libraries.ts and not exported, so these single-field
// schemas are mirrored here (a name is `minLength(1)`).
export const LibraryIdShape = {
  libraryId: z.uuid().describe('Library UUID (from list_libraries)'),
};

// list_library_specs adds an opt-in for withdrawn masters (ADR-030) so an agent
// can discover the spec UUID that restore_spec needs (#416).
export const ListLibrarySpecsShape = {
  ...LibraryIdShape,
  includeWithdrawn: z
    .boolean()
    .describe('Include withdrawn masters (default false), each with its withdrawnAt timestamp')
    .optional(),
};
const ListLibrarySpecsArgs = z.object(ListLibrarySpecsShape);

export const RenameLibraryShape = {
  ...LibraryIdShape,
  name: z.string().check(z.minLength(1)).describe('New name — client-tier libraries only'),
};
const RenameArgs = z.object(RenameLibraryShape);

export const CreateClientLibraryShape = {
  name: z.string().check(z.minLength(1)).describe('Name for the new client library'),
  parentLibraryId: z
    .uuid()
    .describe('Company-tier parent library; defaults to the Default Company Master')
    .optional(),
};
const CreateClientLibraryArgs = z.object(CreateClientLibraryShape);

const NAME_TAKEN_ERROR = 'a library with that name already exists';

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleListLibrarySpecs(args: unknown): Promise<ToolResult> {
  const parsed = ListLibrarySpecsArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid list_library_specs input: libraryId must be a UUID');
  }
  const { libraryId, includeWithdrawn } = parsed.data;
  try {
    const library = await findLibraryById(libraryId);
    if (!library) return toolError(`library not found: id=${libraryId}`);
    return ok(await listLibrarySpecs(libraryId, includeWithdrawn ?? false));
  } catch (err) {
    return internalError(err, 'list_library_specs');
  }
}

export async function handleRenameLibrary(args: unknown): Promise<ToolResult> {
  const parsed = RenameArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid rename_library input: ${issues(parsed.error)}`);
  }
  const { libraryId, name } = parsed.data;
  try {
    const existing = await findLibraryById(libraryId);
    if (!existing) return toolError(`library not found: id=${libraryId}`);
    // Only client-tier libraries are renameable; the seeded reference/company
    // built-ins are immutable (mirrors the REST 422 guard).
    if (existing.tier !== 'client') return toolError('only client libraries can be renamed');
    const updated = await updateLibraryName(libraryId, name);
    if (!updated) return toolError(`library not found: id=${libraryId}`);
    return ok(updated);
  } catch (err) {
    if (getPgCode(err) === '23505') return toolError(NAME_TAKEN_ERROR);
    return internalError(err, 'rename_library');
  }
}

export async function handleCreateClientLibrary(args: unknown): Promise<ToolResult> {
  const parsed = CreateClientLibraryArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid create_client_library input: ${issues(parsed.error)}`);
  }
  const { name, parentLibraryId } = parsed.data;
  const input = parentLibraryId ? { name, parentLibraryId } : { name };
  try {
    return ok(await createClientLibrary(input));
  } catch (err) {
    // Client errors (bad/absent parentLibraryId) — surface without logging.
    if (err instanceof ParentLibraryNotFoundError || err instanceof ParentLibraryNotCompanyError) {
      return toolError(err.message);
    }
    // Server-side seed/config problem — log for observability (parity with the REST 500 path).
    if (err instanceof DefaultCompanyLibraryError) {
      logger.error({ err }, 'mcp tool create_client_library failed');
      return toolError(err.message);
    }
    if (getPgCode(err) === '23505') return toolError(NAME_TAKEN_ERROR);
    return internalError(err, 'create_client_library');
  }
}
