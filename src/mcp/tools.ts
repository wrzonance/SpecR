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
  handleListLibraries,
  handleGetSpec,
  handleListSections,
  handleGetParagraph,
  handleParseDocument,
  handleGenerateDocx,
  handleGetSpecLineage,
  handleGetSpecDiff,
  handleCoordinationReport,
  handleSubmittalRegister,
  handleOpenCommentsReport,
  handleGetNumberingProfile,
} from './handlers.js';
import { registerOnboardingTools } from './onboarding-tools.js';
import { registerProjectTools } from './project-tools.js';
import { registerParagraphTools } from './paragraph-tools.js';
import { registerSpecLifecycleTools } from './spec-lifecycle-tools.js';
import { registerMergeTools } from './merge-tools.js';
import { registerSpecAssignmentTools } from './spec-assignment-tools.js';
import { registerTemplateTools } from './template-tools.js';
import { registerConventionTools } from './convention-tools.js';
import { registerRequiredSectionsTools } from './required-sections-tools.js';
import { registerRevisionNomenclatureTools } from './revision-nomenclature-tools.js';
import { registerNumberingProfileCrudTools } from './numbering-profile-crud-tools.js';
import { registerLibraryManagementTools } from './library-management-tools.js';
import { registerDivisionGeneralTools } from './division-general-tools.js';
import { registerProjectMembershipTools } from './project-membership-tools.js';
import { createRegistrar, type ToolRegistrar } from './tool-registry.js';
import { parseAllowedTiers, TOOL_TIER_VALUES, type ToolTier } from './capabilities.js';
import { config } from '../lib/env.js';

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

function registerLibraryTools(reg: ToolRegistrar): void {
  reg.register(
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

function registerSpecTools(reg: ToolRegistrar): void {
  reg.register(
    'get_spec',
    {
      description:
        'Return the full spec paragraph tree with cross-reference resolution status. Use references[].isResolved to check if referenced specs are loaded. Nodes parsed from DOCX may carry meta.conflicts — inference signal disagreements ({signal, reportedIlvl, reportedNodeType}) indicating the hierarchy level was ambiguous; absent means no disagreement. styleSource is the manually assigned style template ({templateId, templateName}) or null when none is set.',
      inputSchema: {
        specId: z.uuid().describe('Spec UUID (from search_library or list_sections)'),
      },
    },
    handleGetSpec
  );

  reg.register(
    'get_paragraph',
    {
      description:
        'Return a single paragraph with its full ancestor chain (root to immediate parent). Use to get context around a search_library result. The node and each ancestor may carry conflicts — inference signal disagreements recorded at DOCX parse time; absent means the hierarchy was unambiguous.',
      inputSchema: {
        paragraphId: z.uuid().describe('Paragraph UUID (from search_library or get_spec)'),
      },
    },
    handleGetParagraph
  );

  reg.register(
    'get_spec_lineage',
    {
      description:
        'Return the chain of custody for a spec (ADR-015 D6). Walks parent_spec_id from the spec to its root master: chain[0] is the requested spec, the last entry is the root. Per hop, behindBy = parent current contentVersion minus this copy originVersion (drift since clone; null on the root). scope is "library" for a master spec or "project" for a project-owned copy; name is the owning library or project name. originMeta is the root ingest provenance (filename, sha256, loader) or null.',
      inputSchema: {
        specId: z.uuid().describe('Spec UUID (from search_library, list_sections, or get_spec)'),
      },
    },
    handleGetSpecLineage
  );

  reg.register(
    'get_spec_diff',
    {
      description:
        'Return the 3-way merge diff for a returned DOCX. Pass contentBase64 for the edited DOCX bytes; when omitted, the tool diffs a freshly generated DOCX and should return an empty diff for a clean spec.',
      inputSchema: {
        specId: z.uuid().describe('Spec UUID to diff'),
        contentBase64: z
          .string()
          .optional()
          .describe('Base64-encoded returned DOCX content (max 10 MB decoded)'),
      },
    },
    handleGetSpecDiff
  );
}

function registerNumberingProfileTool(reg: ToolRegistrar): void {
  reg.register(
    'get_numbering_profile',
    {
      description:
        'Return the effective structural numbering profile for a spec ' +
        '(tiers, numbering, styleLadder, articleIlvl). ' +
        'An unassigned spec resolves to the built-in CSI Default profile. ' +
        'Returns isError when the spec UUID is not found.',
      inputSchema: {
        specId: z.uuid().describe('Spec UUID (from search_library, list_sections, or get_spec)'),
      },
    },
    handleGetNumberingProfile
  );
}

function registerParserTools(reg: ToolRegistrar): void {
  reg.register(
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

function registerGeneratorTools(reg: ToolRegistrar): void {
  reg.register(
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

function registerCoordinationTools(reg: ToolRegistrar): void {
  reg.register(
    'coordination_report',
    {
      description:
        'Project errors-and-omissions report: required-but-absent sections, ' +
        'present-but-not-required specs, and dangling cross-references. Each ' +
        'dangling_ref pinpoints the source paragraph (sourceParagraphId) and a ' +
        'snippet of the reference in context. Also reports article<->body ' +
        'reference consistency: related_listed_not_cited (a Related Sections ' +
        'entry never cited), related_cited_not_listed (a section cited in the ' +
        'body but not listed), and standard_cited_not_listed (a standard cited ' +
        'but absent from References). Also suggests implied_related_section ' +
        'when a body keyword matches an unlisted in-scope section title. Optional packageId scopes to one design ' +
        'package. Requires a projectId (see list_projects).',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
        packageId: z.uuid().optional().describe('Optional design-package UUID to scope the report'),
      },
    },
    handleCoordinationReport
  );
}

function registerSubmittalTools(reg: ToolRegistrar): void {
  reg.register(
    'submittal_register',
    {
      description:
        'Build a product-driven submittal register for selected project specs. ' +
        'Rows come from PART 2 product candidates, required submittal types come ' +
        'from the PART 1 Submittals article, and datasheet links come from paragraph associations.',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
        specIds: z.array(z.uuid()).describe('Selected project spec UUIDs to include'),
      },
    },
    handleSubmittalRegister
  );
}

function registerOpenCommentsTools(reg: ToolRegistrar): void {
  reg.register(
    'open_comments_report',
    {
      description:
        'List the OPEN (unresolved) Word review comments in a spec or project — the ' +
        'direct answer to "have all comments been closed?" (#256 C1). A comment is ' +
        'closed when its runs are struck through OR its text ends in "Closed". Provide ' +
        'exactly one of specId (see get_spec) or projectId (see list_projects).',
      inputSchema: {
        specId: z.uuid().optional().describe('Spec UUID — report open comments in one spec'),
        projectId: z
          .uuid()
          .optional()
          .describe('Project UUID — aggregate open comments across the project'),
      },
    },
    handleOpenCommentsReport
  );
}

function registerLoaderTools(reg: ToolRegistrar): void {
  reg.register(
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

export function registerTools(
  server: McpServer,
  opts?: { readonly allowedTiers?: ReadonlySet<ToolTier> }
): readonly string[] {
  const allowedTiers = opts?.allowedTiers ?? parseAllowedTiers(config.MCP_ALLOWED_TIERS);
  const reg = createRegistrar(server, allowedTiers);
  registerLibraryTools(reg);
  registerProjectTools(reg);
  registerParagraphTools(reg);
  registerSpecLifecycleTools(reg);
  registerMergeTools(reg);
  registerSpecAssignmentTools(reg);
  registerTemplateTools(reg);
  registerConventionTools(reg);
  registerRequiredSectionsTools(reg);
  registerRevisionNomenclatureTools(reg);
  registerNumberingProfileCrudTools(reg);
  registerLibraryManagementTools(reg);
  registerDivisionGeneralTools(reg);
  registerProjectMembershipTools(reg);
  registerSpecTools(reg);
  registerNumberingProfileTool(reg);
  registerParserTools(reg);
  registerGeneratorTools(reg);
  registerLoaderTools(reg);
  registerCoordinationTools(reg);
  registerSubmittalTools(reg);
  registerOpenCommentsTools(reg);
  registerOnboardingTools(reg);
  return reg.declared;
}

// Test-only convenience: declared names with every tier allowed. Used by the contract test.
export const ALL_TIERS: ReadonlySet<ToolTier> = new Set(TOOL_TIER_VALUES);
