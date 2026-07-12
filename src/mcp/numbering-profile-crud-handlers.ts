import { z } from 'zod';
import {
  findLibraryById,
  listNumberingProfiles,
  getNumberingProfile,
  createNumberingProfile,
  updateNumberingProfile,
  deleteNumberingProfile,
  NumberingProfileInUseError,
} from '../db/index.js';
import { CreateNumberingProfileBodySchema, PatchNumberingProfileBodySchema } from '../ast/index.js';
import { assertDocxSafe, extractNumberingProfileFromDocx } from '../parser/index.js';
import { decodeBase64Payload } from '../lib/decode-base64.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';
import { formatZodIssues } from '../lib/zod-issues.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Shapes exported so the tools advertise exactly what the handlers validate, reusing the
// REST body schemas (one source of truth).
export const LibraryIdShape = {
  libraryId: z.uuid().describe('Library UUID (from list_libraries)'),
};
const LibraryIdArgs = z.object(LibraryIdShape);

export const NumberingProfileIdShape = {
  profileId: z.uuid().describe('Numbering profile UUID (from list_library_numbering_profiles)'),
};
const ProfileIdArgs = z.object(NumberingProfileIdShape);

export const CreateNumberingProfileShape = {
  ...LibraryIdShape,
  ...CreateNumberingProfileBodySchema.shape,
};
const CreateArgs = z.object(CreateNumberingProfileShape);

export const UpdateNumberingProfileShape = {
  ...NumberingProfileIdShape,
  ...PatchNumberingProfileBodySchema.shape,
};
const UpdateArgs = z.object(UpdateNumberingProfileShape);

export const SnapshotNumberingProfileShape = {
  contentBase64: z
    .string()
    .describe('Base64-encoded source `.docx` file (max 10 MB decoded). Nothing is persisted.'),
};
const SnapshotArgs = z.object(SnapshotNumberingProfileShape);

// The built-in CSI Default (library_id IS NULL) is the fallback for every unassigned spec,
// so editing or deleting it would corrupt that global default — it is immutable.
const BUILT_IN_MODIFY_ERROR = 'the built-in CSI Default numbering profile cannot be modified';
const BUILT_IN_DELETE_ERROR = 'the built-in CSI Default numbering profile cannot be deleted';

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleListLibraryNumberingProfiles(args: unknown): Promise<ToolResult> {
  const parsed = LibraryIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid list_library_numbering_profiles input: libraryId must be a UUID');
  }
  try {
    // Verify the parent library first — listNumberingProfiles matches the built-in CSI
    // Default (library_id IS NULL) regardless, so a typo/deleted library UUID would
    // otherwise return just the built-in with no error (#320).
    const library = await findLibraryById(parsed.data.libraryId);
    if (!library) return toolError(`library not found: id=${parsed.data.libraryId}`);
    return ok(await listNumberingProfiles(parsed.data.libraryId));
  } catch (err) {
    return internalError(err, 'list_library_numbering_profiles');
  }
}

export async function handleCreateLibraryNumberingProfile(args: unknown): Promise<ToolResult> {
  const parsed = CreateArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      `invalid create_library_numbering_profile input: ${formatZodIssues(parsed.error)}`
    );
  }
  const { libraryId, name, rules } = parsed.data;
  try {
    return ok(await createNumberingProfile(libraryId, name, rules));
  } catch (err) {
    if (getPgCode(err) === '23503') return toolError(`library not found: id=${libraryId}`);
    return internalError(err, 'create_library_numbering_profile');
  }
}

export async function handleGetNumberingProfileById(args: unknown): Promise<ToolResult> {
  const parsed = ProfileIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_numbering_profile_by_id input: profileId must be a UUID');
  }
  try {
    const profile = await getNumberingProfile(parsed.data.profileId);
    if (!profile) return toolError(`numbering profile not found: id=${parsed.data.profileId}`);
    return ok(profile);
  } catch (err) {
    return internalError(err, 'get_numbering_profile_by_id');
  }
}

export async function handleUpdateNumberingProfile(args: unknown): Promise<ToolResult> {
  const parsed = UpdateArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid update_numbering_profile input: ${formatZodIssues(parsed.error)}`);
  }
  const { profileId, ...patch } = parsed.data;
  try {
    const existing = await getNumberingProfile(profileId);
    if (!existing) return toolError(`numbering profile not found: id=${profileId}`);
    if (existing.libraryId === null) return toolError(BUILT_IN_MODIFY_ERROR);
    const profile = await updateNumberingProfile(profileId, patch);
    if (!profile) return toolError(`numbering profile not found: id=${profileId}`);
    return ok(profile);
  } catch (err) {
    return internalError(err, 'update_numbering_profile');
  }
}

export async function handleDeleteNumberingProfile(args: unknown): Promise<ToolResult> {
  const parsed = ProfileIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid delete_numbering_profile input: profileId must be a UUID');
  }
  const { profileId } = parsed.data;
  try {
    const existing = await getNumberingProfile(profileId);
    if (!existing) return toolError(`numbering profile not found: id=${profileId}`);
    if (existing.libraryId === null) return toolError(BUILT_IN_DELETE_ERROR);
    const deleted = await deleteNumberingProfile(profileId);
    if (!deleted) return toolError(`numbering profile not found: id=${profileId}`);
    return ok({ deleted: true, profileId });
  } catch (err) {
    if (err instanceof NumberingProfileInUseError) {
      return toolError('numbering profile is in use by one or more specs');
    }
    return internalError(err, 'delete_numbering_profile');
  }
}

export async function handleSnapshotNumberingProfile(args: unknown): Promise<ToolResult> {
  const parsed = SnapshotArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid snapshot_numbering_profile input: contentBase64 is required');
  }
  const decoded = decodeBase64Payload(parsed.data.contentBase64);
  if ('error' in decoded) return toolError(decoded.error);
  try {
    await assertDocxSafe(decoded.buffer);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : 'invalid .docx file');
  }
  try {
    return ok(await extractNumberingProfileFromDocx(decoded.buffer));
  } catch (err) {
    // Mirrors the REST 422: the DOCX is well-formed but no profile could be extracted.
    logger.error({ err }, 'mcp tool snapshot_numbering_profile failed');
    return toolError('failed to extract numbering profile from DOCX');
  }
}
