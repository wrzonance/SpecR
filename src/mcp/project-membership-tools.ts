import {
  handleAddProjectSection,
  handleRemoveProjectSection,
  handleSetProjectSources,
  AddProjectSectionShape,
  RemoveProjectSectionShape,
  SetProjectSourcesShape,
} from './project-membership-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerProjectMembershipTools(reg: ToolRegistrar): void {
  registerProjectMembershipWriteTools(reg);
  registerProjectMembershipDestructiveTools(reg);
}

function registerProjectMembershipWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'add_project_section',
    {
      description:
        'Add a CSI section to a project by section number (e.g. "07 21 16"). Copy-on-derive: ' +
        'the section is resolved through the project’s source libraries and cloned into the ' +
        'project. Returns the new spec { specId, section, position, source, shadowed }. isError ' +
        'when the project is unknown, no source library holds the section, or it is already in the project.',
      inputSchema: AddProjectSectionShape,
    },
    handleAddProjectSection
  );

  reg.register(
    'set_project_sources',
    {
      description:
        'Set a project’s ordered source libraries — a non-empty, duplicate-free list of library ' +
        'UUIDs (priority = array order). Libraries must exist and be company- or client-tier ' +
        '(reference-tier rejected). Returns { projectId, sources }. Re-ordering does not re-resolve ' +
        'already-derived sections.',
      inputSchema: SetProjectSourcesShape,
    },
    handleSetProjectSources
  );
}

function registerProjectMembershipDestructiveTools(reg: ToolRegistrar): void {
  reg.register(
    'remove_project_section',
    {
      description:
        'Remove a cloned section from a project (hard delete of the project’s copy; the library ' +
        'master is untouched). Rejected (isError) if the section has project edits — pass ' +
        'force=true to delete them anyway — or if it belongs to a design package (remove it from ' +
        'the package first). Off by default: destructive tier, gated by MCP_ALLOWED_TIERS.',
      inputSchema: RemoveProjectSectionShape,
    },
    handleRemoveProjectSection
  );
}
