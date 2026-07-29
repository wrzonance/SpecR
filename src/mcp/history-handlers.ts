import { z } from 'zod';
import { HistoryAnchorSchema } from '../ast/index.js';
import {
  getParagraphHistory,
  getCoalescedParagraphHistory,
  getSpecHistory,
  getSpecHistoryDiff,
  HistoryAnchorError,
} from '../db/index.js';
import type { ParagraphHistoryEntry, ParagraphHistorySession } from '../db/index.js';
import { config } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { ok, toolError, type ToolResult } from './handlers.js';

export const ParagraphHistoryShape = {
  specId: z.uuid().describe('Spec UUID'),
  nodeId: z.uuid().describe('Paragraph UUID within the spec'),
  includeOrigin: z.boolean().optional().describe('Include the master paragraph before derive'),
  raw: z
    .boolean()
    .optional()
    .describe(
      'Return tier-0 raw iterations instead of the default tier-1 coalesced sessions ' +
        '(ADR-052 D3/D9) — sessions carry sealedByCheckpointId/sealedContentVersion, the ' +
        'checkpoint (from get_checkpoint/list_checkpoints) that sealed them, or null if pending.'
    ),
};
const ParagraphArgs = z.object(ParagraphHistoryShape);

export const SpecHistoryShape = {
  specId: z.uuid().describe('Spec UUID'),
  packageId: z.uuid().optional().describe('Optional package UUID for issuance milestones'),
};
const SpecArgs = z.object(SpecHistoryShape);

export const HistoryDiffShape = {
  specId: z.uuid().describe('Spec UUID'),
  from: HistoryAnchorSchema.describe('Content version, revision UUID, origin, or current'),
  to: HistoryAnchorSchema.describe('Content version, revision UUID, origin, or current'),
};
const DiffArgs = z.object(HistoryDiffShape);

function issues(err: z.ZodError): string {
  return err.issues.map((issue) => issue.message).join('; ');
}

function invalid(tool: string, err: z.ZodError): ToolResult {
  return toolError(`invalid ${tool} input: ${issues(err)}`);
}

function internal(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

/** Tier-0 raw iterations (`raw: true`) or, by default, tier-1 coalesced
 *  sessions (ADR-052 D3/D9) — mirrors the REST `?raw=true` toggle
 *  (src/api/history.ts's loadParagraphHistory). */
async function loadParagraphHistory(
  specId: string,
  nodeId: string,
  includeOrigin: boolean,
  raw: boolean
): Promise<readonly ParagraphHistoryEntry[] | readonly ParagraphHistorySession[] | null> {
  if (raw) return getParagraphHistory(specId, nodeId, includeOrigin);
  return getCoalescedParagraphHistory(
    specId,
    nodeId,
    config.HISTORY_SESSION_WINDOW_MS,
    includeOrigin
  );
}

export async function handleGetParagraphHistory(args: unknown): Promise<ToolResult> {
  const parsed = ParagraphArgs.safeParse(args);
  if (!parsed.success) return invalid('get_paragraph_history', parsed.error);
  try {
    const history = await loadParagraphHistory(
      parsed.data.specId,
      parsed.data.nodeId,
      parsed.data.includeOrigin ?? false,
      parsed.data.raw ?? false
    );
    return history ? ok(history) : toolError('spec or paragraph not found');
  } catch (err) {
    return internal(err, 'get_paragraph_history');
  }
}

export async function handleGetSpecHistory(args: unknown): Promise<ToolResult> {
  const parsed = SpecArgs.safeParse(args);
  if (!parsed.success) return invalid('get_spec_history', parsed.error);
  try {
    const history = await getSpecHistory(parsed.data.specId, parsed.data.packageId);
    return history ? ok(history) : toolError(`spec not found: id=${parsed.data.specId}`);
  } catch (err) {
    return internal(err, 'get_spec_history');
  }
}

export async function handleGetHistoryDiff(args: unknown): Promise<ToolResult> {
  const parsed = DiffArgs.safeParse(args);
  if (!parsed.success) return invalid('get_history_diff', parsed.error);
  try {
    const diff = await getSpecHistoryDiff(parsed.data.specId, parsed.data.from, parsed.data.to);
    return diff ? ok(diff) : toolError(`spec not found: id=${parsed.data.specId}`);
  } catch (err) {
    if (err instanceof HistoryAnchorError) return toolError(err.message);
    return internal(err, 'get_history_diff');
  }
}
