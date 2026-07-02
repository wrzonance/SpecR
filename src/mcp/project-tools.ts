import { z } from 'zod';
import { handleListProjects, handleGetReferences } from './handlers.js';
import { handleCreateProject } from './create-project-handler.js';
import { CreateProjectBodySchema } from '../ast/index.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerProjectTools(reg: ToolRegistrar): void {
  reg.register(
    'create_project',
    {
      description:
        'Create a project. Requires a name and an ordered, non-empty sourceLibraryIds list ' +
        '(company- or client-tier library UUIDs; priority = array order). Returns the new project. ' +
        'Discover library UUIDs with list_projects/search context first.',
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
