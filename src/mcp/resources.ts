// src/mcp/resources.ts
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { getSpecTree, listSpecSections } from '../db/index.js';
import { generateDocx } from '../generator/index.js';
import { renderMarkdown } from '../generator/markdown.js';
import { computeSpecDiff } from '../merge/index.js';
import { logger } from '../lib/logger.js';

async function handleSpecTree(uri: URL, { id }: Variables) {
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
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Spec not found: id=${rawId}` }],
      };
    }
    return {
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderMarkdown(result.tree) }],
    };
  } catch (err) {
    logger.error({ err }, 'mcp resource spec-tree failed');
    return {
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Internal error' }],
    };
  }
}

async function handleCsiSections(uri: URL) {
  try {
    const sections = await listSpecSections();
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

async function handleSpecDiff(uri: URL, { id }: Variables) {
  try {
    const rawId = Array.isArray(id) ? id[0] : id;
    if (typeof rawId !== 'string') {
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Invalid spec id' }] };
    }
    const result = await getSpecTree(rawId);
    if (!result) {
      return {
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Spec not found: id=${rawId}` }],
      };
    }
    const diff = await computeSpecDiff(rawId, await generateDocx(result.tree));
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(diff, null, 2),
        },
      ],
    };
  } catch (err) {
    logger.error({ err }, 'mcp resource spec-diff failed');
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Internal error' }] };
  }
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    'spec-tree',
    new ResourceTemplate('specr://specs/{id}', { list: undefined }),
    {
      description:
        'Full spec as LLM-readable Markdown with CSI hierarchy. Specifier notes rendered as > [NOTE] blockquotes.',
      mimeType: 'text/markdown',
    },
    handleSpecTree
  );

  server.registerResource(
    'csi-sections',
    'specr://sections',
    {
      description:
        'Full CSI MasterFormat section index as a Markdown table with inDatabase (✓) flag.',
      mimeType: 'text/markdown',
    },
    handleCsiSections
  );

  server.registerResource(
    'spec-diff',
    new ResourceTemplate('specr://specs/{id}/diff', { list: undefined }),
    {
      description:
        'Current generated-DOCX 3-way diff for a spec as JSON. Edited DOCX review uses the get_spec_diff tool with contentBase64.',
      mimeType: 'application/json',
    },
    handleSpecDiff
  );
}
