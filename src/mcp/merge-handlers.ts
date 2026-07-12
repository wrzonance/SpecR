import { z } from 'zod';
import { applyMerge, InvalidAcceptedChangeError, MergeError } from '../merge/index.js';
import { StaleVersionError, SpecWriteForbiddenError, SpecNotFoundError } from '../db/index.js';
import { MergeFieldsShape } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Map an edit-gate / merge error to a tool error, or null to fall through to the
// generic internal-error path. Mirrors mergeErrorResponse in the REST layer so the
// merge contract is identical across surfaces. Only messages cross the boundary.
function mergeToolError(err: unknown): ToolResult | null {
  if (err instanceof StaleVersionError) {
    return toolError(
      `stale version — current contentVersion is ${err.currentVersion}; re-run get_spec_diff and retry`
    );
  }
  if (err instanceof SpecWriteForbiddenError) return toolError(err.message);
  if (err instanceof SpecNotFoundError) return toolError('spec not found');
  // InvalidAcceptedChangeError extends MergeError — check the subclass first.
  if (err instanceof InvalidAcceptedChangeError) return toolError(err.message);
  if (err instanceof MergeError) return toolError(err.message);
  return null;
}

// specId (the merge target) plus the shared merge fields, so the tool advertises exactly
// what the handler validates and the big DiffResultSchema is not duplicated.
export const ApplyMergeShape = {
  specId: z.uuid().describe('Spec UUID the accepted changes are merged into'),
  ...MergeFieldsShape,
};
const ApplyMergeArgs = z.object(ApplyMergeShape);

export async function handleApplyMerge(args: unknown): Promise<ToolResult> {
  const parsed = ApplyMergeArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      `invalid apply_merge input: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }
  const { specId, accept, diff, expectedVersion, actorLabel } = parsed.data;
  try {
    const outcome = await applyMerge(specId, accept, diff, expectedVersion, actorLabel);
    if (outcome.kind === 'not-found') return toolError(`spec not found: id=${specId}`);
    return ok({ applied: outcome.applied, rejected: outcome.rejected });
  } catch (err) {
    const mapped = mergeToolError(err);
    if (mapped) return mapped;
    logger.error({ err }, 'mcp tool apply_merge failed');
    return toolError('Internal error — merge apply failed');
  }
}
