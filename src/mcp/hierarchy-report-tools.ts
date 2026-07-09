// src/mcp/hierarchy-report-tools.ts
import { z } from 'zod';
import { getSpecTree, getSpecSource } from '../db/index.js';
import { buildHierarchyReport } from '../lib/hierarchy-report.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

const HierarchyReportShape = {
  specId: z.uuid().describe('Spec UUID (from search_library, list_sections, or get_spec)'),
};
const HierarchyReportArgs = z.object(HierarchyReportShape);

/**
 * get_hierarchy_report — the structured counterpart to GET /specs/:id/hierarchy-report
 * (WS2, #424). Own schema validation (rather than trusting the SDK-level inputSchema
 * alone) so a syntactically invalid specId is rejected before any DB call, mirroring
 * the REST handler's z.uuid().safeParse gate.
 */
export async function handleGetHierarchyReport(args: unknown): Promise<ToolResult> {
  const parsed = HierarchyReportArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_hierarchy_report input: specId must be a UUID');
  }
  const { specId } = parsed.data;
  try {
    const result = await getSpecTree(specId);
    if (!result) return toolError(`spec not found: ${specId}`);
    const source = await getSpecSource(specId);
    return ok(buildHierarchyReport(result.tree, source));
  } catch (err) {
    logger.error({ err }, 'mcp tool get_hierarchy_report failed');
    return toolError('Internal error — hierarchy report failed');
  }
}

/** Read-only per-paragraph hierarchy-scoring report (WS2 #424), contract-bound to
 *  GET /specs/:id/hierarchy-report. */
export function registerHierarchyReportTools(reg: ToolRegistrar): void {
  reg.register(
    'get_hierarchy_report',
    {
      description:
        'Per-paragraph 5-signal inference confidence report for a spec (WS2 #424). Returns ' +
        'counts { scored, unscored, belowThreshold } and paragraphs — ALL scored structural ' +
        'paragraphs, worst-first (ascending confidence), each with { nodeId, nodeType, ilvl, ' +
        'label, preview, confidence, signalUsed, agreed, evidence, conflicts? }. unscoredReason ' +
        '(present when unscored > 0) explains why: explicit-structure source (e.g. UFGS) or a ' +
        'pre-provenance parse. Same underlying data as GET /specs/:id/hierarchy-report.',
      inputSchema: HierarchyReportShape,
    },
    handleGetHierarchyReport
  );
}
