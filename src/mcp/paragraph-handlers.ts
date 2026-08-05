import { z } from 'zod';
import {
  updateParagraphText,
  setParagraphVanish,
  acceptCommentAsNote,
  insertParagraphAfter,
  lockedObjectMessage,
  setParagraphAcknowledged,
  setParagraphCommentClosed,
  StaleVersionError,
  SpecWriteForbiddenError,
  SpecNotFoundError,
} from '../db/index.js';
import {
  UpdateParagraphBodySchema,
  PatchRemovalBodySchema,
  InsertParagraphBodySchema,
  PatchAcknowledgementBodySchema,
  PatchCommentClosureBodySchema,
  ActorLabelSchema,
} from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Map an edit-gate error (ADR-018) to a tool error, or null to fall through to the
// generic 500-equivalent. Mirrors gateErrorResponse in the REST layer so the write
// precondition contract is identical whether reached via REST or MCP. Only the
// message crosses the boundary — never a stack trace.
function gateToolError(err: unknown): ToolResult | null {
  if (err instanceof StaleVersionError) {
    // ADR-085: carries REST's one actionable supplemental field (src/api/
    // edit-gate-response.ts) so an agent can re-read the current version instead
    // of regexing prose. REST's `success`/`error` are not duplicated here — they
    // already have MCP equivalents in `isError` and the text content.
    return toolError(
      `stale version — current contentVersion is ${err.currentVersion}; refetch and retry`,
      { structuredContent: { currentVersion: err.currentVersion } }
    );
  }
  // ADR-085: REST's 409 body for this class carries nothing beyond `error` — no
  // structuredContent to mirror, so the omission here is deliberate, not unfinished.
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
  const { specId, nodeId, text, expectedVersion, actorLabel } = parsed.data;
  try {
    const result = await updateParagraphText(specId, nodeId, text, expectedVersion, actorLabel);
    if (result.status === 'not-found') return toolError(`paragraph not found: id=${nodeId}`);
    if (result.status === 'wrong-spec') return toolError('paragraph does not belong to this spec');
    if (result.status === 'locked-object') {
      // Shares the exact wording with the REST 422 (src/api/paragraphs.ts) via
      // the common lockedObjectMessage (#519, ADR-072 decision 3): an `object`
      // row's content is a captured OOXML blob, editable only through its
      // `objectText` children.
      return toolError(lockedObjectMessage(result.nodeType));
    }
    return ok(result.node);
  } catch (err) {
    const gate = gateToolError(err);
    if (gate) return gate;
    logger.error({ err }, 'mcp tool update_paragraph failed');
    return toolError('Internal error — paragraph update failed');
  }
}

// Path param (specId) plus the REST body shape, reused verbatim so the tool
// advertises exactly the constraints the handler validates — no drift (#372).
export const InsertParagraphShape = {
  specId: z.uuid().describe('Spec UUID (from get_spec / list_sections)'),
  ...InsertParagraphBodySchema.shape,
};
const InsertParagraphArgs = z.object(InsertParagraphShape);

export async function handleInsertParagraph(args: unknown): Promise<ToolResult> {
  const parsed = InsertParagraphArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      `invalid insert_paragraph input: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }
  const { specId, ...input } = parsed.data;
  try {
    const result = await insertParagraphAfter(specId, input);
    if (result.status === 'not-found') {
      return toolError(`anchor paragraph not found: id=${input.anchorNodeId}`);
    }
    if (result.status === 'wrong-spec') {
      return toolError('anchor paragraph does not belong to this spec');
    }
    if (result.status === 'invalid-type') {
      return toolError(
        `node type "${result.nodeType}" cannot be inserted — pass nodeType (article, pr1–pr7, or continuation)`
      );
    }
    return ok(result.node);
  } catch (err) {
    const gate = gateToolError(err);
    if (gate) return gate;
    logger.error({ err }, 'mcp tool insert_paragraph failed');
    return toolError('Internal error — paragraph insert failed');
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
  const { specId, nodeId, removed, actorLabel } = parsed.data;
  try {
    // Reversible soft removal (#251, ADR-022): sets meta.vanish, keeps the row + subtree.
    const result = await setParagraphVanish(specId, nodeId, removed, actorLabel);
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

export const AcknowledgeParagraphShape = {
  specId: z.uuid().describe('Spec UUID (from get_spec / list_sections)'),
  nodeId: z.uuid().describe('Paragraph UUID (a node id within the spec tree, from get_spec)'),
  ...PatchAcknowledgementBodySchema.shape,
};
const AcknowledgeParagraphArgs = z.object(AcknowledgeParagraphShape);

export async function handleAcknowledgeParagraph(args: unknown): Promise<ToolResult> {
  const parsed = AcknowledgeParagraphArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid acknowledge_paragraph input: specId, nodeId (UUIDs) and acknowledged (boolean) are required'
    );
  }
  const { specId, nodeId, acknowledged, actorLabel } = parsed.data;
  try {
    // Affirms a note/textBox object has been read and accepted (#545) —
    // clears its readiness finding WITHOUT hiding the content.
    const result = await setParagraphAcknowledged(specId, nodeId, acknowledged, actorLabel);
    if (result.status === 'not-found') return toolError(`paragraph not found: id=${nodeId}`);
    if (result.status === 'wrong-spec') return toolError('paragraph does not belong to this spec');
    if (result.status === 'not-acknowledgeable') {
      return toolError(
        `node type "${result.nodeType}" cannot be acknowledged — only note nodes and textBox objects are`
      );
    }
    return ok(result.node);
  } catch (err) {
    const gate = gateToolError(err);
    if (gate) return gate;
    logger.error({ err }, 'mcp tool acknowledge_paragraph failed');
    return toolError('Internal error — paragraph acknowledgement failed');
  }
}

export const SetCommentClosedShape = {
  specId: z.uuid().describe('Spec UUID (from get_spec / list_sections)'),
  nodeId: z.uuid().describe('Anchor paragraph UUID whose margin comment is being toggled'),
  index: z
    .number()
    .int()
    .min(0)
    .describe('Zero-based index into the anchor paragraph’s source_facts.comments'),
  ...PatchCommentClosureBodySchema.shape,
};
const SetCommentClosedArgs = z.object(SetCommentClosedShape);

export async function handleSetCommentClosed(args: unknown): Promise<ToolResult> {
  const parsed = SetCommentClosedArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid set_comment_closed input: specId, nodeId (UUIDs), index (integer ≥ 0), and closed (boolean) are required'
    );
  }
  const { specId, nodeId, index, closed, actorLabel } = parsed.data;
  try {
    // The only supported path to clear open_comment (#545).
    const result = await setParagraphCommentClosed(specId, nodeId, index, closed, actorLabel);
    if (result.status === 'not-found') return toolError(`paragraph not found: id=${nodeId}`);
    if (result.status === 'wrong-spec') return toolError('paragraph does not belong to this spec');
    if (result.status === 'no-comment') return toolError(`no comment at index ${index}`);
    return ok(result.node);
  } catch (err) {
    const gate = gateToolError(err);
    if (gate) return gate;
    logger.error({ err }, 'mcp tool set_comment_closed failed');
    return toolError('Internal error — comment closure toggle failed');
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
  actorLabel: ActorLabelSchema.optional().describe(
    'Caller identity attributed to the resulting note in paragraph history; omitted falls back ' +
      'to a system sentinel.'
  ),
};
const AcceptCommentArgs = z.object(AcceptCommentShape);

export async function handleAcceptCommentAsNote(args: unknown): Promise<ToolResult> {
  const parsed = AcceptCommentArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid accept_comment_as_note input: specId, nodeId (UUIDs) and index (integer ≥ 0) are required'
    );
  }
  const { specId, nodeId, index, actorLabel } = parsed.data;
  try {
    // ADR-022 D4: materializes the margin comment as a note sibling. Idempotent —
    // a repeat returns the existing note's id rather than minting a duplicate.
    const outcome = await acceptCommentAsNote(specId, nodeId, index, actorLabel);
    if (outcome.status === 'not-found') return toolError(`paragraph not found: id=${nodeId}`);
    if (outcome.status === 'wrong-spec') return toolError('paragraph does not belong to this spec');
    if (outcome.status === 'no-comment') return toolError(`no comment at index ${index}`);
    // Idempotent success by design: whether the note was just created or already
    // existed, the postcondition (a note sibling with this id) holds — both return
    // ok({ noteId }), matching REST's created-path { noteId } shape. This deliberately
    // diverges from REST's 409-on-already-accepted (an HTTP status-code affordance);
    // an agent tool favors an idempotent success over a conflict error.
    return ok({ noteId: outcome.noteId });
  } catch (err) {
    const gate = gateToolError(err);
    if (gate) return gate;
    logger.error({ err }, 'mcp tool accept_comment_as_note failed');
    return toolError('Internal error — accept comment as note failed');
  }
}
