import {
  handleListRevisionNomenclatureProfiles,
  handleGetProjectRevisionNomenclature,
  handleSetProjectRevisionNomenclature,
  handleCloneProjectRevisionNomenclature,
  handleClearProjectRevisionNomenclature,
  RevisionNomenclatureProjectShape,
  SetRevisionNomenclatureShape,
  CloneRevisionNomenclatureShape,
} from './revision-nomenclature-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerRevisionNomenclatureTools(reg: ToolRegistrar): void {
  registerRevisionNomenclatureReadTools(reg);
  registerRevisionNomenclatureWriteTools(reg);
}

function registerRevisionNomenclatureReadTools(reg: ToolRegistrar): void {
  reg.register(
    'list_revision_nomenclature_profiles',
    {
      description:
        'List the built-in revision-nomenclature profiles — the named revision-type taxonomies ' +
        '(addenda, bulletins, ASIs …) a project can adopt (#209). Use to find a sourceId for ' +
        'clone_project_revision_nomenclature.',
      inputSchema: {},
    },
    handleListRevisionNomenclatureProfiles
  );

  reg.register(
    'get_project_revision_nomenclature',
    {
      description:
        'Return the effective revision-nomenclature profile for a project. `inherited: true` ' +
        'means the project has no profile of its own and falls back to the built-in default.',
      inputSchema: RevisionNomenclatureProjectShape,
    },
    handleGetProjectRevisionNomenclature
  );
}

function registerRevisionNomenclatureWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'set_project_revision_nomenclature',
    {
      description:
        "Create or replace a project's revision-nomenclature profile (name + revision types, " +
        'each with a unique key and optional format/fields). Upsert — one per project. Returns ' +
        'the stored profile.',
      inputSchema: SetRevisionNomenclatureShape,
    },
    handleSetProjectRevisionNomenclature
  );

  reg.register(
    'clone_project_revision_nomenclature',
    {
      description:
        "Seed a project's revision-nomenclature profile by copying an existing one (a built-in " +
        'default or another project’s profile) by sourceId. Overwrites the target. Returns the ' +
        'stored profile.',
      inputSchema: CloneRevisionNomenclatureShape,
    },
    handleCloneProjectRevisionNomenclature
  );

  reg.register(
    'clear_project_revision_nomenclature',
    {
      description:
        "Clear a project's revision-nomenclature override so it falls back to the built-in " +
        'default (reversible). Idempotent. Returns { projectId, cleared: true }.',
      inputSchema: RevisionNomenclatureProjectShape,
    },
    handleClearProjectRevisionNomenclature
  );
}
