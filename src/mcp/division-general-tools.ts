import {
  handleGetLibraryGeneralSpec,
  handleGetProjectGeneralSpec,
  handleSetLibraryGeneralSpec,
  handleSetProjectGeneralSpec,
  LibraryDivisionShape,
  ProjectDivisionShape,
  SetLibraryDivisionShape,
  SetProjectDivisionShape,
} from './division-general-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerDivisionGeneralTools(reg: ToolRegistrar): void {
  registerDivisionGeneralReadTools(reg);
  registerDivisionGeneralWriteTools(reg);
}

const GET_DESCRIPTION =
  'Return the effective division general-spec — the spec that carries a division’s general ' +
  'requirements (its `NN 00 00` section). Auto-resolves: when an exact-section spec exists it ' +
  'is materialized as the config, otherwise `status` is missing/not_applicable with ranked ' +
  'candidates to choose from. Returns isError when the owner is not found.';

const SET_DESCRIPTION =
  'Set a division’s general-spec: provide EITHER generalSpecId (a spec in that division) OR ' +
  'status=not_applicable (exactly one), with optional notes. Returns the updated config. ' +
  'isError when the owner is unknown or the chosen spec is not in the division’s scope.';

function registerDivisionGeneralReadTools(reg: ToolRegistrar): void {
  reg.register(
    'get_library_general_spec',
    { description: GET_DESCRIPTION, inputSchema: LibraryDivisionShape },
    handleGetLibraryGeneralSpec
  );
  reg.register(
    'get_project_general_spec',
    { description: GET_DESCRIPTION, inputSchema: ProjectDivisionShape },
    handleGetProjectGeneralSpec
  );
}

function registerDivisionGeneralWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'set_library_general_spec',
    { description: SET_DESCRIPTION, inputSchema: SetLibraryDivisionShape },
    handleSetLibraryGeneralSpec
  );
  reg.register(
    'set_project_general_spec',
    { description: SET_DESCRIPTION, inputSchema: SetProjectDivisionShape },
    handleSetProjectGeneralSpec
  );
}
