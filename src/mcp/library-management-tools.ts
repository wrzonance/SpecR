import {
  handleListLibrarySpecs,
  handleRenameLibrary,
  handleCreateClientLibrary,
  ListLibrarySpecsShape,
  RenameLibraryShape,
  CreateClientLibraryShape,
} from './library-management-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerLibraryManagementTools(reg: ToolRegistrar): void {
  registerLibraryManagementReadTools(reg);
  registerLibraryManagementWriteTools(reg);
}

function registerLibraryManagementReadTools(reg: ToolRegistrar): void {
  reg.register(
    'list_library_specs',
    {
      description:
        'List the specs a library owns (specId, section, title, node count, withdrawnAt), ordered ' +
        'by section. Withdrawn masters are excluded by default; pass includeWithdrawn=true to ' +
        'surface them (each with a withdrawnAt timestamp) so restore_spec can find their UUID. ' +
        'Returns isError when the library UUID is not found.',
      inputSchema: ListLibrarySpecsShape,
    },
    handleListLibrarySpecs
  );
}

function registerLibraryManagementWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'rename_library',
    {
      description:
        'Rename a library. Only client-tier libraries can be renamed — the built-in reference ' +
        'and company libraries are protected (isError). Names are unique (isError on collision). ' +
        'Returns the updated library.',
      inputSchema: RenameLibraryShape,
    },
    handleRenameLibrary
  );

  reg.register(
    'create_client_library',
    {
      description:
        'Create a new client library under a company-tier parent (defaults to the Default Company ' +
        'Master when parentLibraryId is omitted). owner is set to the name. Returns the new ' +
        'library. isError when the parent is unknown, not company-tier, or the name is taken.',
      inputSchema: CreateClientLibraryShape,
    },
    handleCreateClientLibrary
  );
}
