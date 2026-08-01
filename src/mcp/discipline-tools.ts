import {
  handleListDisciplines,
  handleSetLibraryDisciplines,
  handleClearLibraryDisciplines,
  handleListProjectSpecs,
  ListDisciplinesShape,
  SetLibraryDisciplinesShape,
  ClearLibraryDisciplinesShape,
  ListProjectSpecsShape,
} from './discipline-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerDisciplineTools(reg: ToolRegistrar): void {
  registerDisciplineReadTools(reg);
  registerDisciplineWriteTools(reg);
}

function registerDisciplineReadTools(reg: ToolRegistrar): void {
  reg.register(
    'list_disciplines',
    {
      description:
        'List the discipline catalog (Electrical, HVAC, Plumbing…), each with the CSI division ' +
        'ranges mapped to it (ADR-065). Pass libraryId to resolve a library’s own mapping; omit ' +
        'it (or use a library with no override) for the built-in default. Unmapped disciplines ' +
        'have an empty rules array. Use a discipline key to filter list_library_specs / ' +
        'list_project_specs.',
      inputSchema: ListDisciplinesShape,
    },
    handleListDisciplines
  );

  reg.register(
    'list_project_specs',
    {
      description:
        "List a project's specs (its table-of-contents rows), each with its resolved discipline " +
        'under the built-in default mapping (ADR-065). Pass discipline to keep only specs ' +
        'resolving to that key; a blank or whitespace-only discipline means no filter. ' +
        'Returns isError when the project UUID is not found.',
      inputSchema: ListProjectSpecsShape,
    },
    handleListProjectSpecs
  );
}

function registerDisciplineWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'set_library_disciplines',
    {
      description:
        "Replace a library's discipline rule set wholesale (ADR-065). Each rule maps an inclusive " +
        'CSI division range to a discipline key from list_disciplines; ranges must not overlap ' +
        '(isError). An unknown discipline key is rejected (isError). Returns the resolved catalog.',
      inputSchema: SetLibraryDisciplinesShape,
    },
    handleSetLibraryDisciplines
  );

  reg.register(
    'clear_library_disciplines',
    {
      description:
        "Clear a library's discipline override, reverting it to the built-in default (ADR-065). " +
        'Idempotent — returns { cleared: true } when an override was removed, false when none ' +
        'existed.',
      inputSchema: ClearLibraryDisciplinesShape,
    },
    handleClearLibraryDisciplines
  );
}
