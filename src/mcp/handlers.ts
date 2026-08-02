// src/mcp/handlers.ts
import {
  searchParagraphs,
  toSearchOptions,
  listSpecSections,
  getSpecTree,
  getSpecStyleSource,
  getOnboardingStatus,
  getSpecWithdrawnAt,
  getParagraphWithAncestors,
  getSpecLineage,
  findProjectById,
  findProjectSpecIdsBySection,
  getInboundReferences,
  getOutboundReferences,
  listProjects,
  listLibraries,
  pool,
} from '../db/index.js';
import type { InboundReference, OutboundReference } from '../db/index.js';
import { assertDocxSafe } from '../parser/index.js';
import { generateDocx } from '../generator/index.js';
import { computeSpecDiff, MergeError } from '../merge/index.js';
import { logger } from '../lib/logger.js';
import { decodeBase64Payload } from '../lib/decode-base64.js';
import { normalizeSectionNumber } from '../lib/section-number.js';
import {
  anchorsFromSearch,
  anchorsFromSpecTree,
  anchorsFromReferences,
  anchorsMeta,
} from './anchors.js';
import type { ToolError, ToolResult } from './tool-result.js';

// Re-exported so the ~18 downstream modules/tests that import `type ToolResult`
// from './handlers.js' keep working without re-pointing every importer.
export type { ToolResult };

type ReferenceDirection = 'from' | 'to' | 'both';

// ADR-083: the options object exists only to carry structuredContent, so the
// field is required within it — an empty/no-op options call has no legitimate
// use and would just be call-site noise.
export interface ToolErrorOptions {
  readonly structuredContent: Record<string, unknown>;
}

export function toolError(text: string, options?: ToolErrorOptions): ToolError {
  return {
    isError: true,
    content: [{ type: 'text' as const, text }],
    ...(options ? { structuredContent: options.structuredContent } : {}),
  };
}

/** Wrap a JSON-serializable payload as a successful tool result. Shared by every
 * write-tool handler module so the ok-shape can't drift between them. */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function isToolError(v: unknown): v is ToolError {
  return typeof v === 'object' && v !== null && 'isError' in v;
}

export async function handleSearchLibrary(args: {
  query: string;
  libraryId?: string | undefined;
  projectId?: string | undefined;
  division?: string | undefined;
  part?: number | undefined;
  nodeType?: string | undefined;
  limit: number;
}): Promise<ToolResult> {
  const { query, ...filters } = args;
  try {
    const results = await searchParagraphs(query, toSearchOptions(filters));
    const meta = anchorsMeta(anchorsFromSearch(results));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      ...(meta ? { _meta: meta } : {}),
    };
  } catch (err) {
    logger.error({ err }, 'mcp tool search_library failed');
    return {
      isError: true,
      content: [{ type: 'text' as const, text: 'Internal error — search failed' }],
    };
  }
}

export async function handleGetSpec({ specId }: { specId: string }): Promise<ToolResult> {
  try {
    const result = await getSpecTree(specId);
    if (!result) return toolError(`Spec not found: id=${specId}`);
    // Surface the manual style-source pick (#138) alongside the tree:
    // { templateId, templateName } | null. onboardingStatus (#139): 'review' | 'active'.
    // withdrawnAt (ADR-030 tombstone, #567) mirrors REST's GET /specs/{id} sibling
    // field: ISO timestamp for a withdrawn library master, null otherwise.
    const [styleSource, onboardingStatus, withdrawnAt] = await Promise.all([
      getSpecStyleSource(specId),
      getOnboardingStatus(specId),
      getSpecWithdrawnAt(specId),
    ]);
    const text = JSON.stringify({ ...result, styleSource, onboardingStatus, withdrawnAt }, null, 2);
    const meta = anchorsMeta(anchorsFromSpecTree(result.tree));
    return { content: [{ type: 'text' as const, text }], ...(meta ? { _meta: meta } : {}) };
  } catch (err) {
    logger.error({ err }, 'mcp tool get_spec failed');
    return toolError('Internal error — spec retrieval failed');
  }
}

export async function handleListSections({
  division,
}: {
  division: string | undefined;
}): Promise<ToolResult> {
  try {
    const sections = await listSpecSections(division);
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

export async function handleListLibraries(): Promise<ToolResult> {
  try {
    const libraries = await listLibraries();
    return { content: [{ type: 'text' as const, text: JSON.stringify(libraries, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool list_libraries failed');
    return toolError('Internal error — listing libraries failed');
  }
}

export async function handleListProjects(): Promise<ToolResult> {
  try {
    const projects = await listProjects(pool);
    return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool list_projects failed');
    return toolError('Internal error — project list failed');
  }
}

function includesOutbound(direction: ReferenceDirection): boolean {
  return direction === 'from' || direction === 'both';
}

function includesInbound(direction: ReferenceDirection): boolean {
  return direction === 'to' || direction === 'both';
}

async function getOutboundForSection(
  section: string,
  projectId: string
): Promise<readonly OutboundReference[]> {
  const specIds = await findProjectSpecIdsBySection(section, projectId, pool);
  const refs = await Promise.all(
    specIds.map((specId) => getOutboundReferences(specId, projectId, pool))
  );
  return refs.flat();
}

function referencesResponse(
  projectId: string,
  section: string,
  outbound: readonly OutboundReference[],
  inbound: readonly InboundReference[]
): ToolResult {
  const meta = anchorsMeta(anchorsFromReferences({ section, outbound, inbound }));
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ projectId, section, outbound, inbound }, null, 2),
      },
    ],
    ...(meta ? { _meta: meta } : {}),
  };
}

export async function handleGetReferences({
  projectId,
  section,
  direction,
}: {
  projectId: string;
  section: string;
  direction: ReferenceDirection | undefined;
}): Promise<ToolResult> {
  const normalized = normalizeSectionNumber(section);
  if (normalized === null) {
    return toolError(`Malformed section number: ${section}`);
  }
  try {
    const project = await findProjectById(projectId, pool);
    if (!project) {
      return toolError(`Project not found: id=${projectId}`);
    }
    const resolvedDirection = direction ?? 'both';
    const outbound = includesOutbound(resolvedDirection)
      ? await getOutboundForSection(normalized, projectId)
      : [];
    const inbound = includesInbound(resolvedDirection)
      ? await getInboundReferences(normalized, projectId, pool)
      : [];
    return referencesResponse(projectId, normalized, outbound, inbound);
  } catch (err) {
    logger.error({ err }, 'mcp tool get_references failed');
    return toolError('Internal error — reference retrieval failed');
  }
}

export async function handleGetParagraph({
  paragraphId,
}: {
  paragraphId: string;
}): Promise<ToolResult> {
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

export async function handleGetSpecLineage({ specId }: { specId: string }): Promise<ToolResult> {
  try {
    const lineage = await getSpecLineage(specId);
    if (!lineage) {
      return toolError(`Spec not found: id=${specId}`);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(lineage, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool get_spec_lineage failed');
    return toolError('Internal error — lineage retrieval failed');
  }
}

async function decodeDocxBuffer(contentBase64: string): Promise<Buffer | ToolError> {
  const decoded = decodeBase64Payload(contentBase64);
  if ('error' in decoded) return toolError(decoded.error);
  try {
    await assertDocxSafe(decoded.buffer);
    return decoded.buffer;
  } catch (err) {
    logger.warn({ err }, 'mcp diff DOCX rejected');
    return toolError('invalid DOCX file');
  }
}

async function resolveDiffDocx(
  specId: string,
  contentBase64: string | undefined
): Promise<Buffer | ToolError> {
  if (contentBase64 !== undefined) return decodeDocxBuffer(contentBase64);
  const result = await getSpecTree(specId);
  if (!result) return toolError(`Spec not found: id=${specId}`);
  return generateDocx(result.tree);
}

export async function handleGetSpecDiff({
  specId,
  contentBase64,
}: {
  specId: string;
  contentBase64: string | undefined;
}): Promise<ToolResult> {
  try {
    const buffer = await resolveDiffDocx(specId, contentBase64);
    if (isToolError(buffer)) return buffer;
    const diff = await computeSpecDiff(specId, buffer);
    if (!diff) return toolError(`Spec not found: id=${specId}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(diff, null, 2) }] };
  } catch (err) {
    if (err instanceof MergeError) {
      return toolError(err.message);
    }
    logger.error({ err }, 'mcp tool get_spec_diff failed');
    return toolError('Internal error — diff failed');
  }
}

export { handleCoordinationReport } from './coordination-handler.js';
export { handleSubmittalRegister } from './submittal-register-handler.js';
export { handleOpenCommentsReport } from './open-comments-handler.js';
export { handleGetNumberingProfile } from './numbering-profile-handler.js';
export { handleParseDocument } from './parse-document-handler.js';
export { handleGenerateDocx, toHeaderFooterInput } from './generate-docx-handler.js';
