import { z } from 'zod';
import {
  updateParagraphText,
  setParagraphVanish,
  acceptCommentAsNote,
  StaleVersionError,
  SpecWriteForbiddenError,
  SpecNotFoundError,
} from '../db/index.js';
import { UpdateParagraphBodySchema, PatchRemovalBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, type ToolResult } from './handlers.js';

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// Map an edit-gate error (ADR-018) to a tool error, or null to fall through to the
// generic 500-equivalent. Mirrors gateErrorResponse in the REST layer so the write
// precondition contract is identical whether reached via REST or MCP. Only the
// message crosses the boundary — never a stack trace.
function gateToolError(err: unknown): ToolResult | null {
  if (err instanceof StaleVersionError) {
    return toolError(
      `stale version — current contentVersion is ${err.currentVersion}; refetch and retry`
    );
  }
  if (err instanceof SpecWriteForbiddenError) return toolError(err.message);
  if (err instanceof SpecNotFoundError) return toolError('spec not found');
  return null;
}

// The path params (specId, nodeId) plus the REST body shape, reused verbatim so the
// tool advertises exactly the constraints the handler validates — no drift.
export const UpdateParagraphShape = {
  specId: z.uuid().describe('Spec UUID (from get_spec / list_sections)'),
  nodeId: z.uuid().describe('Paragraph UUID (a node id within the spec tree, from get_spec)'),
  ...UpdateParagraphBodySchema.shape,
};
const UpdateParagraphArgs = z.object(UpdateParagraphShape);

export async function handleUpdateParagraph(args: unknown): Promise<ToolResult> {
  const parsed = UpdateParagraphArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      `invalid update_paragraph input: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }
  const { specId, nodeId, text, expectedVersion } = parsed.data;
  try {
    const result = await updateParagraphText(specId, nodeId, text, expectedVersion);
    if (result.status === 'not-found') return toolError(`paragraph not found: id=${nodeId}`);
    if (result.status === 'wrong-spec') return toolError('paragraph does not belong to this spec');
    return ok(result.node);
  } catch (err) {
    const gate = gateToolError(err);
    if (gate) return gate;
    logger.error({ err }, 'mcp tool update_paragraph failed');
    return toolError('Internal error — paragraph update failed');
  }
}

export const RemoveParagraphShape = {
  specId: z.uuid().describe('Spec UUID (from get_spec / list_sections)'),
  nodeId: z.uuid().describe('Paragraph UUID (a node id within the spec tree, from get_spec)'),
  ...PatchRemovalBodySchema.shape,
};
const RemoveParagraphArgs = z.object(RemoveParagraphShape);

export async function handleRemoveParagraph(args: unknown): Promise<ToolResult> {
  const parsed = RemoveParagraphArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid remove_paragraph input: specId, nodeId (UUIDs) and removed (boolean) are required'
    );
  }
  const { specId, nodeId, removed } = parsed.data;
  try {
    // Reversible soft removal (#251, ADR-022): sets meta.vanish, keeps the row + subtree.
    const result = await setParagraphVanish(specId, nodeId, removed);
    if (result.status === 'not-found') return toolError(`paragraph not found: id=${nodeId}`);
    if (result.status === 'wrong-spec') return toolError('paragraph does not belong to this spec');
    if (result.status === 'not-removable') {
      return toolError(
        `node type "${result.nodeType}" cannot be removed — only body paragraphs are render-suppressible`
      );
    }
    return ok(result.node);
  } catch (err) {
    const gate = gateToolError(err);
    if (gate) return gate;
    logger.error({ err }, 'mcp tool remove_paragraph failed');
    return toolError('Internal error — paragraph removal failed');
  }
}

export const AcceptCommentShape = {
  specId: z.uuid().describe('Spec UUID (from get_spec / list_sections)'),
  nodeId: z.uuid().describe('Anchor paragraph UUID whose margin comment is being accepted'),
  index: z
    .number()
    .int()
    .min(0)
    .describe('Zero-based index into the anchor paragraph’s source_facts.comments'),
};
const AcceptCommentArgs = z.object(AcceptCommentShape);

export async function handleAcceptCommentAsNote(args: unknown): Promise<ToolResult> {
  const parsed = AcceptCommentArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid accept_comment_as_note input: specId, nodeId (UUIDs) and index (integer ≥ 0) are required'
    );
  }
  const { specId, nodeId, index } = parsed.data;
  try {
    // ADR-022 D4: materializes the margin comment as a note sibling. Idempotent —
    // a repeat returns the existing note's id rather than minting a duplicate.
    const outcome = await acceptCommentAsNote(specId, nodeId, index);
    if (outcome.status === 'not-found') return toolError(`paragraph not found: id=${nodeId}`);
    if (outcome.status === 'wrong-spec') return toolError('paragraph does not belong to this spec');
    if (outcome.status === 'no-comment') return toolError(`no comment at index ${index}`);
    return ok({ noteId: outcome.noteId, created: outcome.status === 'created' });
  } catch (err) {
    const gate = gateToolError(err);
    if (gate) return gate;
    logger.error({ err }, 'mcp tool accept_comment_as_note failed');
    return toolError('Internal error — accept comment as note failed');
  }
}
