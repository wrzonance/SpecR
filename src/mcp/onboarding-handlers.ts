// src/mcp/onboarding-handlers.ts
// MCP parity for the onboarding/editability loop (#140). Each handler is a thin
// adapter over the SAME db/index.js query the REST handler calls — no logic is
// reimplemented, so the two surfaces cannot drift. Handlers NEVER throw: every
// failure path returns { isError: true } (CLAUDE.md MCP rule).
import type {
  SpecNode,
  SpecTree,
  Editability,
  ConventionRules,
  ClassificationEvidence,
} from '../ast/index.js';
import {
  getSpecTree,
  getSpecStyleSource,
  getOnboardingStatus,
  setSpecEditabilityOverride,
  clearSpecEditabilityOverride,
  reclassifySpec,
  ConventionValidationError,
} from '../db/index.js';
import type { OwnershipResult } from '../db/index.js';
import { summarizeEditability } from '../lib/editability-summary.js';
import { logger } from '../lib/logger.js';
import { toolError } from './handlers.js';

type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolResult = ToolError | ToolOk;

function jsonResult(payload: unknown): ToolOk {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

// Map a shared OwnershipResult (not-found / wrong-spec) to MCP error text. The
// same status union the REST patch handler maps to 404/403.
function ownershipError(result: OwnershipResult, nodeId: string): ToolError | null {
  if (result.status === 'not-found') return toolError(`Paragraph not found: id=${nodeId}`);
  if (result.status === 'wrong-spec') {
    return toolError(`Paragraph ${nodeId} does not belong to this spec`);
  }
  return null;
}

// ── review_editability ──────────────────────────────────────────────────────

export interface EditabilityReviewEntry {
  readonly nodeId: string;
  readonly value: Editability;
  readonly confidence: number;
  readonly evidence: readonly ClassificationEvidence[];
  readonly override?: Editability;
}

// Walk the persisted tree and emit one entry per CLASSIFIED node. value /
// confidence / evidence / override come straight from getSpecTree's
// meta.editability — byte-identical to what REST and get_spec surface.
function collectEditability(
  nodes: readonly SpecNode[],
  maxConfidence: number,
  out: EditabilityReviewEntry[]
): void {
  for (const n of nodes) {
    const e = n.meta.editability;
    if (e && e.confidence <= maxConfidence) {
      out.push({
        nodeId: n.id,
        value: e.value,
        confidence: e.confidence,
        evidence: e.evidence,
        ...(e.override !== undefined ? { override: e.override } : {}),
      });
    }
    collectEditability(n.children, maxConfidence, out);
  }
}

export async function handleReviewEditability({
  specId,
  maxConfidence,
}: {
  specId: string;
  maxConfidence: number | undefined;
}): Promise<ToolResult> {
  try {
    const result = await getSpecTree(specId);
    if (!result) return toolError(`Spec not found: id=${specId}`);
    const threshold = maxConfidence ?? 1;
    const entries: EditabilityReviewEntry[] = [];
    collectEditability(result.tree.parts, threshold, entries);
    return jsonResult({ specId, maxConfidence: threshold, total: entries.length, entries });
  } catch (err) {
    logger.error({ err }, 'mcp tool review_editability failed');
    return toolError('Internal error — editability review failed');
  }
}

// ── get_onboarding_report ───────────────────────────────────────────────────

function buildReport(
  specId: string,
  tree: SpecTree,
  styleSource: Awaited<ReturnType<typeof getSpecStyleSource>>,
  onboardingStatus: Awaited<ReturnType<typeof getOnboardingStatus>>
): unknown {
  return {
    specId,
    section: tree.section,
    title: tree.title,
    onboardingStatus,
    styleSource,
    styleSourceNeeded: styleSource === null,
    editability: summarizeEditability(tree),
    note:
      'styleDerivation and parseWarnings are import-time-only (the raw uploaded ' +
      'bytes are not persisted); re-import the master to regenerate them.',
  };
}

export async function handleGetOnboardingReport({
  specId,
}: {
  specId: string;
}): Promise<ToolResult> {
  try {
    const result = await getSpecTree(specId);
    if (!result) return toolError(`Spec not found: id=${specId}`);
    const styleSource = await getSpecStyleSource(specId);
    const onboardingStatus = await getOnboardingStatus(specId);
    return jsonResult(buildReport(specId, result.tree, styleSource, onboardingStatus));
  } catch (err) {
    logger.error({ err }, 'mcp tool get_onboarding_report failed');
    return toolError('Internal error — onboarding report failed');
  }
}

// ── set/clear editability override ──────────────────────────────────────────

export async function handleSetEditabilityOverride({
  specId,
  nodeId,
  editability,
}: {
  specId: string;
  nodeId: string;
  editability: Editability;
}): Promise<ToolResult> {
  try {
    const result = await setSpecEditabilityOverride(specId, nodeId, editability);
    const failure = ownershipError(result, nodeId);
    if (failure) return failure;
    return jsonResult({ specId, nodeId, editability });
  } catch (err) {
    logger.error({ err }, 'mcp tool set_editability_override failed');
    return toolError('Internal error — set override failed');
  }
}

export async function handleClearEditabilityOverride({
  specId,
  nodeId,
}: {
  specId: string;
  nodeId: string;
}): Promise<ToolResult> {
  try {
    const result = await clearSpecEditabilityOverride(specId, nodeId);
    const failure = ownershipError(result, nodeId);
    if (failure) return failure;
    return jsonResult({ specId, nodeId, editability: null });
  } catch (err) {
    logger.error({ err }, 'mcp tool clear_editability_override failed');
    return toolError('Internal error — clear override failed');
  }
}

// ── reclassify_spec ─────────────────────────────────────────────────────────

export async function handleReclassifySpec({
  specId,
  rules,
  preview,
}: {
  specId: string;
  rules: ConventionRules | undefined;
  preview: boolean | undefined;
}): Promise<ToolResult> {
  try {
    const opts: { rules?: ConventionRules; preview?: boolean } = {};
    if (rules !== undefined) opts.rules = rules;
    if (preview !== undefined) opts.preview = preview;
    const outcome = await reclassifySpec(specId, opts);
    if (outcome.status === 'not-found') return toolError(`Spec not found: id=${specId}`);
    if (outcome.status === 'no-convention') {
      return toolError('No convention profile resolvable for this spec; supply rules');
    }
    return jsonResult(outcome.report);
  } catch (err) {
    if (err instanceof ConventionValidationError) {
      return toolError(`Unsafe convention rules: ${err.message}`);
    }
    logger.error({ err }, 'mcp tool reclassify_spec failed');
    return toolError('Internal error — reclassify failed');
  }
}
