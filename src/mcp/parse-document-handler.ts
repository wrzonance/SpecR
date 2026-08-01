// src/mcp/parse-document-handler.ts
// Extracted from handlers.ts (file-size budget, CLAUDE.md max-lines=400) — the
// parse_document tool is a self-contained decode → parse → infer → persist
// pipeline. ToolOk/ToolError/ToolResult come from the shared ./tool-result.js
// module; the local toolErr/isToolError helpers mirror the pattern used by the
// other standalone handler files (coordination-handler.ts,
// submittal-register-handler.ts, numbering-profile-handler.ts,
// open-comments-handler.ts).
//
// #567: dispatchParse's own hand-rolled per-extension branching (and the
// inference it re-derived on top) is gone — this now calls parser/index.ts's
// unified `parse()`, the same orchestrator src/lib/parse-worker.ts already
// runs for REST uploads. That buys three things in one move: .pdf support,
// the three override params (section/title/numberingProfileId), and
// `applyInference`'s existing "never let an 'unknown' inference overwrite a
// real value" guard — the old inline enrichInferenceForMcp lacked that guard
// and could stomp a real title with 'unknown' when only the section was
// content-inferred.
import path from 'node:path';
import type { SpecNode, SpecTree, SecRef } from '../ast/types.js';
import type { NumberingProfile } from '../ast/index.js';
import { persistParsedSpec, lookupSpecSectionTitle, getNumberingProfile } from '../db/index.js';
import type { OriginMeta } from '../db/index.js';
import { computeTitleMatch } from '../lib/infer-section.js';
import type { SectionInference } from '../lib/infer-section.js';
import { parse, assertDocxSafe, assertSecSafe, assertPdfSafe } from '../parser/index.js';
import type { ParseOptions } from '../parser/index.js';
import { parseSectionNumberCandidate } from '../lib/section-number.js';
import { decodeBase64Payload } from '../lib/decode-base64.js';
import { logger } from '../lib/logger.js';
import { parseLog, logParseWarnings } from '../lib/log-context.js';
import { sha256Hex } from '../lib/hash.js';
import { sanitizeFilename } from '../lib/filename.js';
import { ALLOWED_PARSE_EXTENSIONS } from '../lib/parse-extensions.js';
import { parseOptionsFromConfig } from '../lib/parse-options.js';
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

async function decodeSafeBuffer(ext: string, contentBase64: string): Promise<Buffer | ToolError> {
  const decoded = decodeBase64Payload(contentBase64);
  if ('error' in decoded) return toolErr(decoded.error);
  const buf = decoded.buffer;
  try {
    if (ext === '.docx') {
      await assertDocxSafe(buf);
    } else if (ext === '.pdf') {
      assertPdfSafe(buf); // synchronous — matches REST's own un-awaited call site
    } else if (ext === '.sec') {
      // Return value (decoded text) discarded here — parser/index.ts's parse()
      // re-derives it internally. Matches REST's own pre-existing
      // assertUploadSafe → runParseWorker double-assert on .sec (not a
      // regression introduced by this change).
      assertSecSafe(buf);
    }
    return buf;
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

// Only adds the DB-dependent standardTitle/titleMatch/titleMatchScore fields —
// section/title inference itself (incl. the "never overwrite a real value with
// 'unknown'" guard) already ran inside parser/index.ts's parse().
async function enrichInferenceForMcp(
  tree: SpecTree,
  refs: readonly SecRef[],
  sectionInference: SectionInference
): Promise<{ tree: SpecTree; refs: readonly SecRef[]; sectionInference: SectionInference }> {
  if (sectionInference.method === 'metadata' || sectionInference.confidence === 'none') {
    return { tree, refs, sectionInference };
  }
  const standardTitle = await resolveStandardTitleForMcp(sectionInference.inferredSection);
  const { titleMatch, titleMatchScore } = computeTitleMatch(
    sectionInference.inferredTitle,
    standardTitle
  );
  const enriched: SectionInference = {
    ...sectionInference,
    ...(standardTitle !== null ? { standardTitle } : {}),
    titleMatch,
    ...(titleMatchScore !== undefined ? { titleMatchScore } : {}),
  };
  return { tree, refs, sectionInference: enriched };
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
  nodeCount: number,
  capabilities?: readonly string[]
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    specId,
    section: tree.section,
    title: tree.title,
    nodeCount,
  };
  // Mirrors REST's own `...(capabilities !== undefined ? { capabilities } : {})`
  // (api/parse.ts). parse_document's tool description promises callers a
  // `capabilities: ["read-only"]` for .txt/.pdf sources, so dropping the
  // parser's flags here would make the tool contradict its own contract.
  if (capabilities !== undefined) response['capabilities'] = capabilities;
  if (tree.warnings && tree.warnings.length > 0) response['warnings'] = tree.warnings;
  if (sectionInference.method !== 'metadata') {
    response['sectionInference'] = { ...sectionInference, note: INFERENCE_NOTE };
  }
  return response;
}

interface McpParseOverrides {
  readonly section?: string;
  readonly title?: string;
  readonly numberingProfile?: NumberingProfile;
}

interface RawMcpParseOverrides {
  readonly section: string | undefined;
  readonly title: string | undefined;
  readonly numberingProfileId: string | undefined;
}

// Mirrors api/parse.ts's resolveSectionOverride: same candidate parser, same
// 'strong' context, same error text — a section override an agent supplies
// must survive the exact same canonicalization REST applies. Returns are
// wrapped in `{ value }` (rather than a bare `string | undefined`) so this
// stays a two-shape union — `{ value }` or `ToolError` — instead of three,
// per CLAUDE.md's ESLint `sonarjs/function-return-type` gate.
function resolveMcpSectionOverride(
  raw: string | undefined
): { readonly value: string | undefined } | ToolError {
  if (raw === undefined) return { value: undefined };
  const parsed = parseSectionNumberCandidate(raw, 'strong');
  if (parsed?.ok !== true) return toolErr('invalid section override format');
  return { value: parsed.canonical };
}

// Mirrors api/parse.ts's resolveRequestedProfile: same lookup, same error text
// for an id that doesn't resolve to a stored profile.
async function resolveMcpNumberingProfile(
  id: string | undefined
): Promise<{ readonly value: NumberingProfile | undefined } | ToolError> {
  if (id === undefined) return { value: undefined };
  const profile = await getNumberingProfile(id);
  if (!profile) return toolErr('numbering profile not found');
  return { value: profile.rules };
}

async function resolveMcpParseOverrides(
  raw: RawMcpParseOverrides
): Promise<McpParseOverrides | ToolError> {
  const sectionResult = resolveMcpSectionOverride(raw.section);
  if (isToolError(sectionResult)) return sectionResult;
  const profileResult = await resolveMcpNumberingProfile(raw.numberingProfileId);
  if (isToolError(profileResult)) return profileResult;
  return {
    ...(sectionResult.value !== undefined ? { section: sectionResult.value } : {}),
    // Truthiness, not `!== undefined` — deliberately REST's exact test
    // (api/parse.ts: `...(body.title ? { title: body.title } : {})`). An empty
    // string is a no-op override on both surfaces; treating it as a real value
    // would persist a tree whose title violates SpecTreeSchema's minLength(1).
    ...(raw.title ? { title: raw.title } : {}),
    ...(profileResult.value !== undefined ? { numberingProfile: profileResult.value } : {}),
  };
}

// The env-derived OCR policy is NOT optional here: this path parses .pdf, and
// parseOptionsFromConfig carries OCR_REQUIRE_LOCAL_TRAINEDDATA (which blocks
// Tesseract's network fetch of trained data) plus the configured thresholds,
// cache path, render scale and init timeout. Passing only the numbering
// profile would let an MCP upload bypass the very policy the REST worker
// enforces on every upload (#567 review finding) — both ingest paths derive
// their options from lib/parse-options.ts so a setting can never apply to one
// surface and not the other.
function parseOptionsFor(overrides: McpParseOverrides): ParseOptions {
  return {
    ...parseOptionsFromConfig(),
    ...(overrides.numberingProfile !== undefined
      ? { numberingProfile: overrides.numberingProfile }
      : {}),
  };
}

export async function handleParseDocument({
  filename,
  contentBase64,
  section,
  title,
  numberingProfileId,
}: {
  filename: string;
  contentBase64: string;
  section?: string | undefined;
  title?: string | undefined;
  numberingProfileId?: string | undefined;
}): Promise<ToolResult> {
  try {
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_PARSE_EXTENSIONS.has(ext)) {
      return toolErr(`Unsupported extension: ${ext}. Use .docx, .pdf, .sec, or .txt`);
    }
    const overrides = await resolveMcpParseOverrides({ section, title, numberingProfileId });
    if (isToolError(overrides)) return overrides;
    const bufOrErr = await decodeSafeBuffer(ext, contentBase64);
    if (isToolError(bufOrErr)) return bufOrErr;

    const parsed = await parse(bufOrErr, filename, parseOptionsFor(overrides));
    const enriched = await enrichInferenceForMcp(parsed.tree, parsed.refs, parsed.sectionInference);
    // Overrides apply LAST — REST's own override-always-wins precedence
    // (api/parse.ts:220-224): an explicit caller-supplied section/title beats
    // whatever the parser detected or inferred.
    const finalTree: SpecTree = {
      ...enriched.tree,
      ...(overrides.section !== undefined ? { section: overrides.section } : {}),
      ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    };

    const originMeta = buildMcpOriginMeta(filename, contentBase64);
    const specId = await persistParsedSpec({ tree: finalTree, refs: enriched.refs, originMeta });
    const nodeCount = countNodes(finalTree.parts);
    const response = buildParseResponse(
      specId,
      finalTree,
      enriched.sectionInference,
      nodeCount,
      parsed.capabilities
    );
    logParseWarnings(parseLog({ ...originMeta, specId }), finalTree.warnings ?? []);
    return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool parse_document failed');
    return toolErr('Internal error — parse failed');
  }
}
