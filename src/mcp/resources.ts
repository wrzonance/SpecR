// src/mcp/resources.ts
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSpecTree, listCsiSections } from '../db/index.js';
import { renderMarkdown } from '../generator/markdown.js';
import { logger } from '../lib/logger.js';

export function registerResources(server: McpServer): void {
  server.registerResource(
    'spec-tree',
    new ResourceTemplate('specr://specs/{id}', { list: undefined }),
    {
      description:
        'Full spec as LLM-readable Markdown with CSI hierarchy. Specifier notes rendered as > [NOTE] blockquotes.',
      mimeType: 'text/markdown',
    },
    async (uri, { id }) => {
      try {
        const rawId = Array.isArray(id) ? id[0] : id;
        if (typeof rawId !== 'string') {
          return {
            contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Invalid spec id' }],
          };
        }
        const result = await getSpecTree(rawId);
        if (!result) {
          return {
            contents: [
              { uri: uri.href, mimeType: 'text/plain', text: `Spec not found: id=${rawId}` },
            ],
          };
        }
        return {
          contents: [
            { uri: uri.href, mimeType: 'text/markdown', text: renderMarkdown(result.tree) },
          ],
        };
      } catch (err) {
        logger.error({ err }, 'mcp resource spec-tree failed');
        return {
          contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Internal error' }],
        };
      }
    }
  );

  server.registerResource(
    'csi-sections',
    'specr://sections',
    {
      description:
        'Full CSI MasterFormat section index as a Markdown table with inDatabase (✓) flag.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      try {
        const sections = await listCsiSections();
        const header = '| Section | Title | In DB |\n|---------|-------|-------|\n';
        const rows = sections
          .map((s) => `| ${s.section} | ${s.title} | ${s.inDatabase ? '✓' : ''} |`)
          .join('\n');
        return {
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text: header + rows }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp resource csi-sections failed');
        return {
          contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Internal error' }],
        };
      }
    }
  );
}
