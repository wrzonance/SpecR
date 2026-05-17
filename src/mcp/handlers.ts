// src/mcp/handlers.ts
import path from 'node:path';
import type { CsiNode, CsiTree, SecRef } from '../ast/types.js';
import {
  searchParagraphs,
  listCsiSections,
  getSpecTree,
  getParagraphWithAncestors,
  persistParsedSpec,
  lookupCsiSectionTitle,
} from '../db/index.js';
import { inferSectionMeta, computeTitleMatch } from '../lib/infer-section.js';
import type { SectionInference } from '../lib/infer-section.js';
import { parseSec, parseDocx, parseText, assertDocxSafe, assertSecSafe } from '../parser/index.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { generateDocx } from '../generator/index.js';
import { logger } from '../lib/logger.js';

type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolResult = ToolError | ToolOk;

export function toolError(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

function isToolError(v: unknown): v is ToolError {
  return typeof v === 'object' && v !== null && 'isError' in v;
}

export function countNodes(nodes: readonly CsiNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
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
    return await lookupCsiSectionTitle(section);
  } catch {
    return null;
  }
}

async function enrichInferenceForMcp(
  tree: CsiTree,
  refs: readonly SecRef[]
): Promise<{ tree: CsiTree; refs: readonly SecRef[]; sectionInference: SectionInference }> {
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

export async function handleListSections({
  division,
}: {
  division: string | undefined;
}): Promise<ToolResult> {
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
): Promise<{ tree: CsiTree; refs: readonly SecRef[] } | ToolError> {
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
    const specId = await persistParsedSpec(enriched);
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
