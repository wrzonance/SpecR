// src/mcp/parse-document-handler.ts
// Extracted from handlers.ts (file-size budget, CLAUDE.md max-lines=400) — the
// parse_document tool is a self-contained decode → parse → infer → persist
// pipeline. ToolOk/ToolError/ToolResult come from the shared ./tool-result.js
// module; the local toolErr/isToolError helpers mirror the pattern used by the
// other standalone handler files (coordination-handler.ts,
// submittal-register-handler.ts, numbering-profile-handler.ts,
// open-comments-handler.ts).
import path from 'node:path';
import type { SpecNode, SpecTree, SecRef } from '../ast/types.js';
import { persistParsedSpec, lookupSpecSectionTitle } from '../db/index.js';
import type { OriginMeta } from '../db/index.js';
import { inferSectionMeta, computeTitleMatch } from '../lib/infer-section.js';
import type { SectionInference } from '../lib/infer-section.js';
import {
  parseSec,
  parseDocx,
  parseText,
  extractRefsFromTree,
  assertDocxSafe,
  assertSecSafe,
} from '../parser/index.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { decodeBase64Payload } from '../lib/decode-base64.js';
import { logger } from '../lib/logger.js';
import { parseLog } from '../lib/log-context.js';
import { sha256Hex } from '../lib/hash.js';
import { sanitizeFilename } from '../lib/filename.js';
import type { ToolError, ToolResult } from './tool-result.js';

// Sourced from UFGS reference corpus — not authoritative CSI MasterFormat.
const INFERENCE_NOTE =
  'Section metadata missing. Section number and title inferred from document content. Standard title (if present) sourced from UFGS reference corpus — not authoritative CSI MasterFormat. Please verify.';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

function isToolError(v: unknown): v is ToolError {
  return typeof v === 'object' && v !== null && 'isError' in v;
}

function countNodes(nodes: readonly SpecNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

async function decodeSafeBuffer(
  ext: string,
  contentBase64: string
): Promise<Buffer | string | ToolError> {
  const decoded = decodeBase64Payload(contentBase64);
  if ('error' in decoded) return toolErr(decoded.error);
  const buf = decoded.buffer;
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
    return toolErr(err instanceof Error ? err.message : 'invalid file');
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

async function dispatchParse(
  ext: string,
  buf: Buffer | string
): Promise<{ tree: SpecTree; refs: readonly SecRef[] } | ToolError> {
  const noop = (_stage: string, _pct: number): void => {};
  if (ext === '.sec') {
    if (typeof buf !== 'string') return toolErr('invalid .sec payload');
    return parseSec(buf);
  }
  if (ext === '.txt') {
    if (!Buffer.isBuffer(buf)) return toolErr('invalid .txt payload');
    const { tree, refs } = parseText(decodeTextBuffer(buf));
    return { tree, refs };
  }
  if (!Buffer.isBuffer(buf)) return toolErr('invalid .docx payload');
  // Derive refs from the parsed tree, matching the REST parse/load path
  // (parseDocxBuffer → extractRefsFromTree). Section/title inference downstream
  // only reshapes the tree root, so node ids — and thus ref sourceNodeIds —
  // stay aligned with the paragraphs persisted by persistParsedSpec (#332).
  const tree = await parseDocx(buf, noop);
  return { tree, refs: extractRefsFromTree(tree) };
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

// Pure — assembles the tool response payload from already-computed pieces, so
// it is testable without stubbing parse/persist/DB.
export function buildParseResponse(
  specId: string,
  tree: SpecTree,
  sectionInference: SectionInference,
  nodeCount: number
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    specId,
    section: tree.section,
    title: tree.title,
    nodeCount,
  };
  if (tree.warnings && tree.warnings.length > 0) response['warnings'] = tree.warnings;
  if (sectionInference.method !== 'metadata') {
    response['sectionInference'] = { ...sectionInference, note: INFERENCE_NOTE };
  }
  return response;
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
      return toolErr(`Unsupported extension: ${ext}. Use .docx, .sec, or .txt`);
    }
    const bufOrErr = await decodeSafeBuffer(ext, contentBase64);
    if (isToolError(bufOrErr)) return bufOrErr;
    const rawOrErr = await dispatchParse(ext, bufOrErr);
    if (isToolError(rawOrErr)) return rawOrErr;
    const enriched = await enrichInferenceForMcp(rawOrErr.tree, rawOrErr.refs);
    const originMeta = buildMcpOriginMeta(filename, contentBase64);
    const specId = await persistParsedSpec({ ...enriched, originMeta });
    const nodeCount = countNodes(enriched.tree.parts);
    const response = buildParseResponse(
      specId,
      enriched.tree,
      enriched.sectionInference,
      nodeCount
    );
    const log = parseLog({ ...originMeta, specId });
    if (enriched.tree.warnings?.length)
      log.warn({ warnings: enriched.tree.warnings }, 'parse produced warnings');
    return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool parse_document failed');
    return toolErr('Internal error — parse failed');
  }
}
