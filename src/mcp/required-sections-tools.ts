import {
  handleGetRequiredSections,
  handleSetRequiredSections,
  handleGetPackageRequiredSections,
  handleSetPackageRequiredSections,
  RequiredSectionsProjectShape,
  RequiredSectionsPackageShape,
  SetRequiredSectionsShape,
  SetPackageRequiredSectionsShape,
} from './required-sections-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

const SET_DESCRIPTION =
  'Provide either an explicit `sections` list (section number + optional title, no ' +
  'duplicates) OR `seedFrom` to derive them — "baseline" (project baseline), "toc" (the ' +
  'package table of contents), or { packageId } — never both. Replaces the current set. ' +
  'Returns the stored required sections. These drive the coordination_report’s ' +
  'required-but-absent check.';

export function registerRequiredSectionsTools(reg: ToolRegistrar): void {
  registerRequiredSectionsReadTools(reg);
  registerRequiredSectionsWriteTools(reg);
}

function registerRequiredSectionsReadTools(reg: ToolRegistrar): void {
  reg.register(
    'get_required_sections',
    {
      description:
        'List the required sections for a project baseline (the sections a coordination ' +
        'report expects to be present). Returns the stored set.',
      inputSchema: RequiredSectionsProjectShape,
    },
    handleGetRequiredSections
  );

  reg.register(
    'get_package_required_sections',
    {
      description:
        'List the required sections for a specific design package within a project. Returns the ' +
        'stored set.',
      inputSchema: RequiredSectionsPackageShape,
    },
    handleGetPackageRequiredSections
  );
}

function registerRequiredSectionsWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'set_required_sections',
    {
      description: `Set the required sections for a project baseline. ${SET_DESCRIPTION}`,
      inputSchema: SetRequiredSectionsShape,
    },
    handleSetRequiredSections
  );

  reg.register(
    'set_package_required_sections',
    {
      description: `Set the required sections for a design package. ${SET_DESCRIPTION}`,
      inputSchema: SetPackageRequiredSectionsShape,
    },
    handleSetPackageRequiredSections
  );
}
