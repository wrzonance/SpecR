import { z } from 'zod';
import { HistoryAnchorSchema } from '../ast/index.js';
import {
  getParagraphHistory,
  getSpecHistory,
  getSpecHistoryDiff,
  HistoryAnchorError,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { ok, toolError, type ToolResult } from './handlers.js';

export const ParagraphHistoryShape = {
  specId: z.uuid().describe('Spec UUID'),
  nodeId: z.uuid().describe('Paragraph UUID within the spec'),
  includeOrigin: z.boolean().optional().describe('Include the master paragraph before derive'),
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

function invalid(tool: string): ToolResult {
  return toolError(`invalid ${tool} input`);
}

function internal(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleGetParagraphHistory(args: unknown): Promise<ToolResult> {
  const parsed = ParagraphArgs.safeParse(args);
  if (!parsed.success) return invalid('get_paragraph_history');
  try {
    const history = await getParagraphHistory(
      parsed.data.specId,
      parsed.data.nodeId,
      parsed.data.includeOrigin ?? false
    );
    return history ? ok(history) : toolError('spec or paragraph not found');
  } catch (err) {
    return internal(err, 'get_paragraph_history');
  }
}

export async function handleGetSpecHistory(args: unknown): Promise<ToolResult> {
  const parsed = SpecArgs.safeParse(args);
  if (!parsed.success) return invalid('get_spec_history');
  try {
    const history = await getSpecHistory(parsed.data.specId, parsed.data.packageId);
    return history ? ok(history) : toolError(`spec not found: id=${parsed.data.specId}`);
  } catch (err) {
    return internal(err, 'get_spec_history');
  }
}

export async function handleGetHistoryDiff(args: unknown): Promise<ToolResult> {
  const parsed = DiffArgs.safeParse(args);
  if (!parsed.success) return invalid('get_history_diff');
  try {
    const diff = await getSpecHistoryDiff(parsed.data.specId, parsed.data.from, parsed.data.to);
    return diff ? ok(diff) : toolError(`spec not found: id=${parsed.data.specId}`);
  } catch (err) {
    if (err instanceof HistoryAnchorError) return toolError(err.message);
    return internal(err, 'get_history_diff');
  }
}
