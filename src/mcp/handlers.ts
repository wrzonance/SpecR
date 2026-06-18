// src/mcp/handlers.ts
import path from 'node:path';
import type { SpecNode, SpecTree, SecRef } from '../ast/types.js';
import {
  searchParagraphs,
  listSpecSections,
  getSpecTree,
  getSpecStyleSource,
  getParagraphWithAncestors,
  persistParsedSpec,
  lookupSpecSectionTitle,
  getSpecLineage,
  findProjectById,
  findProjectSpecIdsBySection,
  getInboundReferences,
  getOutboundReferences,
  listProjects,
  pool,
} from '../db/index.js';
import type { InboundReference, OriginMeta, OutboundReference } from '../db/index.js';
import { inferSectionMeta, computeTitleMatch } from '../lib/infer-section.js';
import type { SectionInference } from '../lib/infer-section.js';
import { parseSec, parseDocx, parseText, assertDocxSafe, assertSecSafe } from '../parser/index.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { generateDocx } from '../generator/index.js';
import { computeSpecDiff, MergeError } from '../merge/index.js';
import { logger } from '../lib/logger.js';
import { sha256Hex } from '../lib/hash.js';
import { sanitizeFilename } from '../lib/filename.js';
import { normalizeSectionNumber } from '../lib/section-number.js';

type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
export type ToolResult = ToolError | ToolOk;
type ReferenceDirection = 'from' | 'to' | 'both';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function toolError(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

function isToolError(v: unknown): v is ToolError {
  return typeof v === 'object' && v !== null && 'isError' in v;
}

export function countNodes(nodes: readonly SpecNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

async function decodeSafeBuffer(
  ext: string,
  contentBase64: string
): Promise<Buffer | string | ToolError> {
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
    } else if (ext === '.sec') {
      return assertSecSafe(buf);
    } else {
      return buf;
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : 'invalid file');
  }
}

async function resolveStandardTitleForMcp(section: string): Promise<string | null> {
  try {
    return await lookupSpecSectionTitle(section);
  } catch {
    return null;
  }
}

async function enrichInferenceForMcp(
  tree: SpecTree,
  refs: readonly SecRef[]
): Promise<{ tree: SpecTree; refs: readonly SecRef[]; sectionInference: SectionInference }> {
  const raw = inferSectionMeta(tree);
  if (raw.method === 'metadata' || raw.confidence === 'none') {
    return { tree, refs, sectionInference: raw };
  }
  const updatedTree = { ...tree, section: raw.inferredSection, title: raw.inferredTitle };
  const standardTitle = await resolveStandardTitleForMcp(raw.inferredSection);
  const { titleMatch, titleMatchScore } = computeTitleMatch(raw.inferredTitle, standardTitle);
  const sectionInference: SectionInference = {
    ...raw,
    ...(standardTitle !== null ? { standardTitle } : {}),
    titleMatch,
    ...(titleMatchScore !== undefined ? { titleMatchScore } : {}),
  };
  return { tree: updatedTree, refs, sectionInference };
}

export async function handleSearchLibrary({
  query,
  division,
  limit,
}: {
  query: string;
  division: string | undefined;
  limit: number;
}): Promise<ToolResult> {
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

export async function handleGetSpec({ specId }: { specId: string }): Promise<ToolResult> {
  try {
    const result = await getSpecTree(specId);
    if (!result) return toolError(`Spec not found: id=${specId}`);
    // Surface the manual style-source pick (#138) alongside the tree:
    // { templateId, templateName } | null.
    const styleSource = await getSpecStyleSource(specId);
    const text = JSON.stringify({ ...result, styleSource }, null, 2);
    return { content: [{ type: 'text' as const, text }] };
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
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ projectId, section, outbound, inbound }, null, 2),
      },
    ],
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

async function dispatchParse(
  ext: string,
  buf: Buffer | string
): Promise<{ tree: SpecTree; refs: readonly SecRef[] } | ToolError> {
  const noop = (_stage: string, _pct: number): void => {};
  if (ext === '.sec') {
    if (typeof buf !== 'string') return toolError('invalid .sec payload');
    return parseSec(buf);
  }
  if (ext === '.txt') {
    if (!Buffer.isBuffer(buf)) return toolError('invalid .txt payload');
    const { tree, refs } = parseText(decodeTextBuffer(buf));
    return { tree, refs };
  }
  if (!Buffer.isBuffer(buf)) return toolError('invalid .docx payload');
  return { tree: await parseDocx(buf, noop), refs: [] };
}

function buildMcpOriginMeta(filename: string, contentBase64: string): OriginMeta {
  return {
    filename: sanitizeFilename(filename),
    // hash the raw ingested bytes (base64-decoded), not decoded/transformed text;
    // deliberate second decode — decodeSafeBuffer's .sec branch returns decoded
    // text, not the raw bytes provenance needs
    sha256: sha256Hex(Buffer.from(contentBase64, 'base64')),
    loader: 'mcp:parse_document',
  };
}

export async function handleParseDocument({
  filename,
  contentBase64,
}: {
  filename: string;
  contentBase64: string;
}): Promise<ToolResult> {
  try {
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.docx' && ext !== '.sec' && ext !== '.txt') {
      return toolError(`Unsupported extension: ${ext}. Use .docx, .sec, or .txt`);
    }
    const bufOrErr = await decodeSafeBuffer(ext, contentBase64);
    if (isToolError(bufOrErr)) return bufOrErr;
    const rawOrErr = await dispatchParse(ext, bufOrErr);
    if (isToolError(rawOrErr)) return rawOrErr;
    const enriched = await enrichInferenceForMcp(rawOrErr.tree, rawOrErr.refs);
    const originMeta = buildMcpOriginMeta(filename, contentBase64);
    const specId = await persistParsedSpec({ ...enriched, originMeta });
    const nodeCount = countNodes(enriched.tree.parts);
    const response: Record<string, unknown> = {
      specId,
      section: enriched.tree.section,
      title: enriched.tree.title,
      nodeCount,
    };
    if (enriched.sectionInference.method !== 'metadata') {
      response['sectionInference'] = {
        ...enriched.sectionInference,
        note: 'Section metadata missing. Section number and title inferred from document content. Standard title (if present) sourced from UFGS reference corpus — not authoritative CSI MasterFormat. Please verify.',
      };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool parse_document failed');
    return toolError('Internal error — parse failed');
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

export async function handleGenerateDocx({ specId }: { specId: string }): Promise<ToolResult> {
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

async function decodeDocxBuffer(contentBase64: string): Promise<Buffer | ToolError> {
  if (!BASE64_RE.test(contentBase64)) return toolError('contentBase64 is not valid base64');
  const estimatedBytes = Math.ceil((contentBase64.length * 3) / 4);
  if (estimatedBytes > 10 * 1024 * 1024) {
    return toolError('Content exceeds 10 MB decoded limit');
  }
  const buf = Buffer.from(contentBase64, 'base64');
  try {
    await assertDocxSafe(buf);
    return buf;
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
