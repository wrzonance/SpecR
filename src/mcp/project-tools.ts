import { z } from 'zod';
import { handleListProjects, handleGetReferences } from './handlers.js';
import { handleCreateProject } from './create-project-handler.js';
import {
  handleGetProject,
  handleUpdateProject,
  handleDeleteProject,
  handleRestoreProject,
} from './project-handlers.js';
import { CreateProjectBodySchema } from '../ast/index.js';
import { SectionNumberFormatSchema } from '../lib/section-number.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerProjectTools(reg: ToolRegistrar): void {
  registerProjectCoreTools(reg);
  registerProjectLifecycleTools(reg);
}

function registerProjectCoreTools(reg: ToolRegistrar): void {
  reg.register(
    'create_project',
    {
      description:
        'Create a project. Requires a name and an ordered, non-empty sourceLibraryIds list ' +
        '(company- or client-tier library UUIDs; priority = array order). Returns the new project. ' +
        'Discover library UUIDs with list_libraries.',
      inputSchema: CreateProjectBodySchema.shape,
    },
    (args) => handleCreateProject(args)
  );

  reg.register(
    'list_projects',
    {
      description: 'List projects (id, name) for use as the projectId argument to get_references.',
      inputSchema: {},
    },
    handleListProjects
  );

  reg.register(
    'get_references',
    {
      description:
        'Within a project, return cross-references for a CSI section in both directions: ' +
        'outbound (specs this section cites) and inbound (specs that cite it). ' +
        'Read directly from the database — deterministic and complete, including inbound ' +
        'references to sections not yet loaded. Requires a projectId (see list_projects).',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
        section: z
          .string()
          .min(1)
          .describe('CSI section number, e.g. "09 91 00" (expanded shapes ok)'),
        direction: z
          .enum(['from', 'to', 'both'])
          .optional()
          .describe('"from" = specs this section cites; "to" = specs that cite it; default "both"'),
      },
    },
    handleGetReferences
  );
}

function registerProjectLifecycleTools(reg: ToolRegistrar): void {
  reg.register(
    'get_project',
    {
      description: 'Return a single project by UUID, including its table of contents.',
      inputSchema: { projectId: z.uuid().describe('Project UUID (from list_projects)') },
    },
    handleGetProject
  );

  reg.register(
    'update_project',
    {
      description:
        'Update a project. Provide projectId and at least one of: name, sectionNumberFormat. ' +
        'Returns the updated project.',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
        name: z.string().min(1).optional().describe('New project name'),
        sectionNumberFormat: SectionNumberFormatSchema.optional().describe(
          'Project section-number display format'
        ),
      },
    },
    handleUpdateProject
  );

  reg.register(
    'delete_project',
    {
      description:
        'Soft-delete a project (ADR-031 — recoverable via restore_project). Requires projectId ' +
        'and deletedBy (audit actor). Destructive: exposed only when the destructive tier is enabled.',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
        deletedBy: z.string().min(1).describe('Who is deleting it (audit trail)'),
      },
    },
    handleDeleteProject
  );

  reg.register(
    'restore_project',
    {
      description: 'Restore a soft-deleted project (ADR-031). Idempotent for a live project.',
      inputSchema: { projectId: z.uuid().describe('Project UUID (from list_projects)') },
    },
    handleRestoreProject
  );
}
