// src/mcp/library-tools.ts
// Library-facing read tools: ranked full-text search plus library/section discovery.
import { z } from 'zod';
import { NodeTypeSchema } from '../ast/index.js';
import { handleSearchLibrary, handleListLibraries, handleListSections } from './handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

const divisionSchema = z
  .string()
  .regex(/^\d{2}$/)
  .optional()
  .describe('Filter by 2-digit CSI division, e.g. "27"');

function registerSearchTool(reg: ToolRegistrar): void {
  reg.register(
    'search_library',
    {
      description:
        'Ranked full-text search over the CSI paragraph library (ADR-062): stemmed, ' +
        'proximity-aware ranking with highlighted snippets. Each hit carries the paragraph ' +
        'UUID, spec id, section, title, snippet, and rank. Scope with libraryId/projectId, ' +
        'division, part (CSI PART 1/2/3), and nodeType. Same query path as REST GET /search.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            'Search text (natural language or keywords; supports quoted phrases, or, -negation)'
          ),
        libraryId: z
          .uuid()
          .optional()
          .describe('Scope to specs owned by this library master (UUID)'),
        projectId: z.uuid().optional().describe('Scope to specs owned by this project (UUID)'),
        division: divisionSchema,
        part: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe('Restrict to CSI PART 1 (General), 2 (Products), or 3 (Execution)'),
        nodeType: NodeTypeSchema.optional().describe(
          'Restrict to a paragraph node type (part, article, pr1…pr7, note)'
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Maximum results to return (1–100, default 20)'),
      },
    },
    handleSearchLibrary
  );
}

export function registerLibraryTools(reg: ToolRegistrar): void {
  registerSearchTool(reg);

  reg.register(
    'list_libraries',
    {
      description:
        'List all paragraph libraries (id, name, tier). Use to obtain the sourceLibraryIds ' +
        'required by create_project — no other tool surfaces library UUIDs.',
      inputSchema: {},
    },
    handleListLibraries
  );

  reg.register(
    'list_sections',
    {
      description:
        'List CSI MasterFormat sections with inDatabase flag. Use to discover which specs are loaded and identify library gaps.',
      inputSchema: { division: divisionSchema },
    },
    handleListSections
  );
}
