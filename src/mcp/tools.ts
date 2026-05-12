// src/mcp/tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchParagraphs, listCsiSections, getSpecTree } from '../db/index.js';
import { logger } from '../lib/logger.js';

export function registerTools(server: McpServer): void {
  server.registerTool(
    'search_library',
    {
      description:
        'Search the CSI paragraph library by text content. Returns matching paragraphs with spec context (section, title, node type).',
      inputSchema: {
        query: z.string().min(1).describe('Text to search for in paragraph content'),
        division: z
          .string()
          .regex(/^\d{2}$/)
          .optional()
          .describe('Filter by 2-digit CSI division, e.g. "27"'),
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
    async ({ query, division, limit }) => {
      try {
        const results = await searchParagraphs(query, division, limit ?? 20);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp tool search_library failed');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Internal error — search failed' }],
        };
      }
    }
  );

  server.registerTool(
    'get_spec',
    {
      description:
        'Return the full spec paragraph tree with cross-reference resolution status. Use references[].isResolved to check if referenced specs are loaded.',
      inputSchema: {
        specId: z.string().uuid().describe('Spec UUID (from search_library or list_sections)'),
      },
    },
    async ({ specId }) => {
      try {
        const result = await getSpecTree(specId);
        if (!result) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Spec not found: id=${specId}` }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp tool get_spec failed');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Internal error — spec retrieval failed' }],
        };
      }
    }
  );

  server.registerTool(
    'list_sections',
    {
      description:
        'List CSI MasterFormat sections with inDatabase flag. Use to discover which specs are loaded and identify library gaps.',
      inputSchema: {
        division: z
          .string()
          .regex(/^\d{2}$/)
          .optional()
          .describe('Filter by 2-digit CSI division, e.g. "27"'),
      },
    },
    async ({ division }) => {
      try {
        const sections = await listCsiSections(division);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(sections, null, 2) }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp tool list_sections failed');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Internal error — section list failed' }],
        };
      }
    }
  );
}
