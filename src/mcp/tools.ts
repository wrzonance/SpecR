// src/mcp/tools.ts
import path from 'node:path';
import { glob } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  searchParagraphs,
  listCsiSections,
  getSpecTree,
  getParagraphWithAncestors,
  persistParsedSpec,
} from '../db/index.js';
import { parseSec, parseDocx, assertDocxSafe, assertSecSafe } from '../parser/index.js';
import { generateDocx } from '../generator/index.js';
import { loadFiles } from '../lib/file-loader.js';
import type { CsiNode, CsiTree, SecRef } from '../ast/types.js';
import { logger } from '../lib/logger.js';

function countNodes(nodes: readonly CsiNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolResult = ToolError | ToolOk;

function toolError(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

function isToolError(v: Buffer | string | ToolError): v is ToolError {
  return typeof v === 'object' && 'isError' in v;
}

async function decodeSafeBuffer(
  ext: string,
  contentBase64: string
): Promise<Buffer | string | ToolError> {
  const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!BASE64_RE.test(contentBase64)) {
    return toolError('contentBase64 is not valid base64');
  }
  const estimatedBytes = Math.ceil((contentBase64.length * 3) / 4);
  if (estimatedBytes > 10 * 1024 * 1024) {
    return toolError('Content exceeds 10 MB decoded limit');
  }
  const buf = Buffer.from(contentBase64, 'base64');
  try {
    if (ext === '.docx') {
      await assertDocxSafe(buf);
      return buf;
    } else {
      return assertSecSafe(buf);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : 'invalid file');
  }
}

async function handleParseDocument({
  filename,
  contentBase64,
}: {
  filename: string;
  contentBase64: string;
}): Promise<ToolResult> {
  try {
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.docx' && ext !== '.sec') {
      return toolError(`Unsupported extension: ${ext}. Use .docx or .sec`);
    }
    const bufOrErr = await decodeSafeBuffer(ext, contentBase64);
    if (isToolError(bufOrErr)) return bufOrErr;
    const noop = (_stage: string, _pct: number): void => {};
    const parseResult: { tree: CsiTree; refs: readonly SecRef[] } =
      ext === '.sec'
        ? parseSec(bufOrErr as string)
        : { tree: await parseDocx(bufOrErr as Buffer, noop), refs: [] };
    const specId = await persistParsedSpec(parseResult);
    const nodeCount = countNodes(parseResult.tree.parts);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { specId, section: parseResult.tree.section, title: parseResult.tree.title, nodeCount },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    logger.error({ err }, 'mcp tool parse_document failed');
    return toolError('Internal error — parse failed');
  }
}

async function handleSearchLibrary({
  query,
  division,
  limit,
}: {
  query: string;
  division: string | undefined;
  limit: number;
}) {
  try {
    const results = await searchParagraphs(query, division, limit);
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

async function handleGetSpec({ specId }: { specId: string }) {
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

async function handleListSections({ division }: { division: string | undefined }) {
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

async function handleGetParagraph({ paragraphId }: { paragraphId: string }) {
  try {
    const result = await getParagraphWithAncestors(paragraphId);
    if (!result) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Paragraph not found: id=${paragraphId}` }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    logger.error({ err }, 'mcp tool get_paragraph failed');
    return {
      isError: true,
      content: [{ type: 'text' as const, text: 'Internal error — paragraph retrieval failed' }],
    };
  }
}

async function handleGenerateDocx({ specId }: { specId: string }): Promise<ToolResult> {
  try {
    const result = await getSpecTree(specId);
    if (!result) {
      return toolError(`Spec not found: id=${specId}`);
    }
    const buf = await generateDocx(result.tree);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              specId,
              section: result.tree.section,
              title: result.tree.title,
              sizeBytes: buf.byteLength,
              contentBase64: buf.toString('base64'),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    logger.error({ err }, 'mcp tool generate_docx failed');
    return toolError('Internal error — DOCX generation failed');
  }
}

const divisionSchema = z
  .string()
  .regex(/^\d{2}$/)
  .optional()
  .describe('Filter by 2-digit CSI division, e.g. "27"');

function registerLibraryTools(server: McpServer): void {
  server.registerTool(
    'search_library',
    {
      description:
        'Search the CSI paragraph library by text content. Returns matching paragraphs with spec context (section, title, node type).',
      inputSchema: {
        query: z.string().min(1).describe('Text to search for in paragraph content'),
        division: divisionSchema,
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

  server.registerTool(
    'list_sections',
    {
      description:
        'List CSI MasterFormat sections with inDatabase flag. Use to discover which specs are loaded and identify library gaps.',
      inputSchema: { division: divisionSchema },
    },
    handleListSections
  );
}

function registerSpecTools(server: McpServer): void {
  server.registerTool(
    'get_spec',
    {
      description:
        'Return the full spec paragraph tree with cross-reference resolution status. Use references[].isResolved to check if referenced specs are loaded.',
      inputSchema: {
        specId: z.uuid().describe('Spec UUID (from search_library or list_sections)'),
      },
    },
    handleGetSpec
  );

  server.registerTool(
    'get_paragraph',
    {
      description:
        'Return a single paragraph with its full ancestor chain (root to immediate parent). Use to get context around a search_library result.',
      inputSchema: {
        paragraphId: z.uuid().describe('Paragraph UUID (from search_library or get_spec)'),
      },
    },
    handleGetParagraph
  );
}

function registerParserTools(server: McpServer): void {
  server.registerTool(
    'parse_document',
    {
      description:
        'Parse a DOCX or SEC specification file and store it in the database. Pass the file content as base64. Returns the new spec ID and summary. Note: computation-intensive for large DOCX files.',
      inputSchema: {
        filename: z
          .string()
          .describe('Original filename — extension determines format (.docx or .sec)'),
        contentBase64: z.string().describe('Base64-encoded file content (max 10 MB decoded)'),
      },
    },
    handleParseDocument
  );
}

function registerGeneratorTools(server: McpServer): void {
  server.registerTool(
    'generate_docx',
    {
      description:
        'Generate a DOCX file from a stored spec. Returns base64-encoded content (typically 50–400 KB). Note: generates on-demand from current database state — not cached. Avoid calling in tight loops.',
      inputSchema: {
        specId: z.uuid().describe('Spec UUID to generate DOCX for'),
      },
    },
    handleGenerateDocx
  );
}

function guardPath(fp: string, projectRoot: string): ToolError | null {
  const abs = path.resolve(fp);
  if (!abs.startsWith(projectRoot + path.sep) && abs !== projectRoot) {
    return toolError(`path is outside project root: ${fp}`);
  }
  return null;
}

async function handleLoadFiles({
  glob: globPattern,
  paths: explicitPaths,
  dry_run,
}: {
  glob: string | undefined;
  paths: string[] | undefined;
  dry_run: boolean | undefined;
}): Promise<ToolResult> {
  if (!globPattern && (!explicitPaths || explicitPaths.length === 0)) {
    return toolError('Provide at least one of: glob, paths');
  }
  try {
    const resolved: string[] = [];
    if (globPattern) {
      const matches = await Array.fromAsync(glob(globPattern, { cwd: process.cwd() }));
      resolved.push(...matches.map((m) => path.resolve(m)));
    }
    if (explicitPaths) {
      const projectRoot = process.cwd();
      for (const fp of explicitPaths) {
        const err = guardPath(fp, projectRoot);
        if (err) return err;
        resolved.push(path.resolve(fp));
      }
    }
    const result = await loadFiles(resolved, { dryRun: dry_run ?? false });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool load_files failed');
    return toolError('Internal error — file loading failed');
  }
}

function registerLoaderTools(server: McpServer): void {
  server.registerTool(
    'load_files',
    {
      description:
        'Bulk-load spec files into the library from a glob pattern or explicit paths. Accepts .SEC and .docx formats. Returns a summary of succeeded, failed, and any error details. Idempotent — re-loading an existing spec updates it.',
      inputSchema: {
        glob: z
          .string()
          .optional()
          .describe('Glob pattern relative to project root, e.g. "docs/references/UFGS/**/*.SEC"'),
        paths: z
          .array(z.string())
          .optional()
          .describe('Explicit file paths (absolute or relative to project root)'),
        dry_run: z
          .boolean()
          .optional()
          .describe('If true, parse files but skip database writes — useful for validation'),
      },
    },
    handleLoadFiles
  );
}

export function registerTools(server: McpServer): void {
  registerLibraryTools(server);
  registerSpecTools(server);
  registerParserTools(server);
  registerGeneratorTools(server);
  registerLoaderTools(server);
}
