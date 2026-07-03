import {
  handleListConventions,
  handleGetLibraryConventions,
  handleSetLibraryConventions,
  handleCloneConventions,
  ConventionLibraryIdShape,
  SetConventionShape,
  CloneConventionShape,
} from './convention-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerConventionTools(reg: ToolRegistrar): void {
  registerConventionReadTools(reg);
  registerConventionWriteTools(reg);
}

function registerConventionReadTools(reg: ToolRegistrar): void {
  reg.register(
    'list_conventions',
    {
      description:
        'List the built-in editing-convention profiles (the industry-default rule sets that ' +
        'classify editor clues — colors, choice tokens, banners; ADR-022). Use to find a ' +
        'sourceId for clone_conventions.',
      inputSchema: {},
    },
    handleListConventions
  );

  reg.register(
    'get_library_conventions',
    {
      description:
        'Return the effective editing-convention profile for a library. `inherited: true` means ' +
        'the library has no profile of its own and falls back to the built-in industry default.',
      inputSchema: ConventionLibraryIdShape,
    },
    handleGetLibraryConventions
  );
}

function registerConventionWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'set_library_conventions',
    {
      description:
        "Create or replace a library's own editing-convention profile (name + rules). Upsert — " +
        'one profile per library. An unsafe/catastrophic regex in the rules is rejected. Returns ' +
        'the stored convention.',
      inputSchema: SetConventionShape,
    },
    handleSetLibraryConventions
  );

  reg.register(
    'clone_conventions',
    {
      description:
        "Seed a library's editing-convention profile by copying an existing one (a built-in " +
        'default or another library’s profile) identified by sourceId. Overwrites the target ' +
        "library's profile. Returns the stored convention.",
      inputSchema: CloneConventionShape,
    },
    handleCloneConventions
  );
}
