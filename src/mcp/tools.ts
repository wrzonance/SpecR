// src/mcp/tools.ts
import path from 'node:path';
import { glob, realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadFiles } from '../lib/file-loader.js';
import { logger } from '../lib/logger.js';
import {
  toolError,
  handleSearchLibrary,
  handleGetSpec,
  handleListSections,
  handleGetParagraph,
  handleParseDocument,
  handleGenerateDocx,
} from './handlers.js';

type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolResult = ToolError | ToolOk;
type PathResolution = { readonly ok: true; readonly paths: string[] } | ToolError;

function isToolError(v: Buffer | string | ToolError | PathResolution): v is ToolError {
  return typeof v === 'object' && 'isError' in v;
}

function pathOk(paths: string[]): PathResolution {
  return { ok: true, paths };
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
          .describe(
            'Original filename — extension determines format (.docx, .sec, or .txt). Plaintext .txt returns capabilities: ["read-only"] in result.'
          ),
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

async function guardPath(fp: string, projectRoot: string): Promise<ToolError | null> {
  try {
    const root = await realpath(projectRoot);
    let abs: string;
    try {
      abs = await realpath(path.resolve(projectRoot, fp));
    } catch (realpathErr) {
      logger.debug(
        { err: realpathErr, fp },
        'guardPath: realpath failed (file may not exist), falling back to lexical check'
      );
      abs = path.resolve(fp);
    }
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return toolError(`path is outside project root: ${fp}`);
    }
    return null;
  } catch (err) {
    logger.warn({ err, fp }, 'guardPath: containment check failed');
    return toolError(`path containment check failed: ${fp}`);
  }
}

async function resolveGlobPaths(globPattern: string, projectRoot: string): Promise<PathResolution> {
  const matches = await Array.fromAsync(glob(globPattern, { cwd: projectRoot }));
  const resolved: string[] = [];
  for (const m of matches) {
    const guardErr = await guardPath(m, projectRoot);
    if (guardErr) return guardErr;
    resolved.push(path.resolve(projectRoot, m));
  }
  return pathOk(resolved);
}

async function resolveExplicitPaths(
  explicitPaths: string[],
  projectRoot: string
): Promise<PathResolution> {
  const resolved: string[] = [];
  for (const fp of explicitPaths) {
    const err = await guardPath(fp, projectRoot);
    if (err) return err;
    resolved.push(path.resolve(fp));
  }
  return pathOk(resolved);
}

async function collectResolvedPaths(
  globPattern: string | undefined,
  explicitPaths: string[] | undefined,
  projectRoot: string
): Promise<PathResolution> {
  const resolved: string[] = [];
  if (globPattern) {
    const globResult = await resolveGlobPaths(globPattern, projectRoot);
    if (isToolError(globResult)) return globResult;
    resolved.push(...globResult.paths);
  }
  if (explicitPaths && explicitPaths.length > 0) {
    const pathResult = await resolveExplicitPaths(explicitPaths, projectRoot);
    if (isToolError(pathResult)) return pathResult;
    resolved.push(...pathResult.paths);
  }
  return pathOk(resolved);
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
    const projectRoot = process.cwd();
    const resolved = await collectResolvedPaths(globPattern, explicitPaths, projectRoot);
    if (isToolError(resolved)) return resolved;
    const result = await loadFiles(resolved.paths, { dryRun: dry_run ?? false });
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
        'Bulk-load spec files into the library from a glob pattern or explicit paths. Accepts .SEC, .docx, and .txt formats. Returns a summary of succeeded, failed, and any error details. Idempotent — re-loading an existing spec updates it. Plaintext specs (.txt) are read-only — no round-trip merge anchors.',
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
