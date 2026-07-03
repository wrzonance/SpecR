import {
  handleListPackages,
  handleCreatePackage,
  handleSetPackageSpecs,
  handleDeletePackage,
  ProjectIdShape,
  PackageIdShape,
  CreatePackageShape,
  SetPackageSpecsShape,
} from './package-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerPackageTools(reg: ToolRegistrar): void {
  registerPackageReadTools(reg);
  registerPackageWriteTools(reg);
  registerPackageDestructiveTools(reg);
}

function registerPackageReadTools(reg: ToolRegistrar): void {
  reg.register(
    'list_packages',
    {
      description:
        'List a project’s design packages (each with its ordered member specs). A design package ' +
        'is a subset of the project’s sections issued together. Returns isError when the project ' +
        'UUID is not found.',
      inputSchema: ProjectIdShape,
    },
    handleListPackages
  );
}

function registerPackageWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'create_package',
    {
      description:
        'Create a design package in a project (name unique per project). Position is auto-assigned ' +
        'to the end. Add members with set_package_specs. Returns the new package summary. isError ' +
        'when the project is unknown or the name is already taken.',
      inputSchema: CreatePackageShape,
    },
    handleCreatePackage
  );

  reg.register(
    'set_package_specs',
    {
      description:
        'Set a package’s member specs (full replacement, ordered by the specIds array; an empty ' +
        'array clears it). Every specId must be in the package’s own project TOC. Returns ' +
        '{ packageId, specs }. isError when the package is unknown or a spec is not in the project.',
      inputSchema: SetPackageSpecsShape,
    },
    handleSetPackageSpecs
  );
}

function registerPackageDestructiveTools(reg: ToolRegistrar): void {
  reg.register(
    'delete_package',
    {
      description:
        'Permanently delete a design package. CASCADE: this also destroys the package’s membership ' +
        'AND all of its issued revisions and their frozen snapshots — there is no guard for issued ' +
        'revisions. Off by default: destructive tier, gated by MCP_ALLOWED_TIERS.',
      inputSchema: PackageIdShape,
    },
    handleDeletePackage
  );
}
