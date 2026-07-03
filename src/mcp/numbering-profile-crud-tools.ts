import {
  handleListLibraryNumberingProfiles,
  handleCreateLibraryNumberingProfile,
  handleGetNumberingProfileById,
  handleUpdateNumberingProfile,
  handleDeleteNumberingProfile,
  handleSnapshotNumberingProfile,
  LibraryIdShape,
  NumberingProfileIdShape,
  CreateNumberingProfileShape,
  UpdateNumberingProfileShape,
  SnapshotNumberingProfileShape,
} from './numbering-profile-crud-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerNumberingProfileCrudTools(reg: ToolRegistrar): void {
  registerNumberingProfileCrudReadTools(reg);
  registerNumberingProfileCrudWriteTools(reg);
  registerNumberingProfileCrudDestructiveTools(reg);
}

function registerNumberingProfileCrudReadTools(reg: ToolRegistrar): void {
  reg.register(
    'list_library_numbering_profiles',
    {
      description:
        "List a library's numbering profiles — the named CSI multilevel-numbering rule sets " +
        '(tiers, numbering, styleLadder) a spec can adopt (#299). Includes the singleton ' +
        'built-in CSI Default (libraryId: null), listed last. Use to find a profileId.',
      inputSchema: LibraryIdShape,
    },
    handleListLibraryNumberingProfiles
  );

  reg.register(
    'get_numbering_profile_by_id',
    {
      description:
        'Return one numbering profile row by its UUID (name + rules). Distinct from ' +
        'get_numbering_profile, which resolves the *effective* profile for a spec. Returns ' +
        'isError when the profile UUID is not found.',
      inputSchema: NumberingProfileIdShape,
    },
    handleGetNumberingProfileById
  );

  reg.register(
    'snapshot_numbering_profile',
    {
      description:
        'Extract a NumberingProfile (tiers, numbering, styleLadder, articleIlvl) from a source ' +
        '.docx without persisting anything — preview what profile a source-of-truth DOCX yields ' +
        'before creating a permanent one. Pass the file as base64 (max 10 MB decoded).',
      inputSchema: SnapshotNumberingProfileShape,
    },
    handleSnapshotNumberingProfile
  );
}

function registerNumberingProfileCrudWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'create_library_numbering_profile',
    {
      description:
        'Create a new named numbering profile owned by a library. `rules` carries the ' +
        'NumberingProfile shape (tiers, numbering, styleLadder). Returns the new profile row. ' +
        'Returns isError when the library UUID is not found.',
      inputSchema: CreateNumberingProfileShape,
    },
    handleCreateLibraryNumberingProfile
  );

  reg.register(
    'update_numbering_profile',
    {
      description:
        'Partial update of a numbering profile — supply name and/or rules; omit a field to ' +
        'leave it unchanged. The built-in CSI Default (libraryId: null) is protected and ' +
        'cannot be modified. Returns the updated profile row.',
      inputSchema: UpdateNumberingProfileShape,
    },
    handleUpdateNumberingProfile
  );
}

function registerNumberingProfileCrudDestructiveTools(reg: ToolRegistrar): void {
  reg.register(
    'delete_numbering_profile',
    {
      description:
        'Permanently delete a library-owned numbering profile. Rejected (isError) if it is the ' +
        'built-in CSI Default or still assigned to any spec (RESTRICT) — reassign those specs ' +
        'first. Off by default: destructive tier, gated by MCP_ALLOWED_TIERS.',
      inputSchema: NumberingProfileIdShape,
    },
    handleDeleteNumberingProfile
  );
}
