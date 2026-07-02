import { z } from 'zod';
import {
  createAssociation,
  listAssociationsForParagraph,
  deleteAssociation,
  AssociationParagraphNotFoundError,
  pool,
} from '../db/index.js';
import { CreateAssociationBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, type ToolResult } from './handlers.js';

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export const ParagraphRefShape = {
  specId: z.uuid().describe('Spec UUID (from get_spec / list_sections)'),
  nodeId: z.uuid().describe('Paragraph UUID (a node id within the spec tree, from get_spec)'),
};
const ParagraphRef = z.object(ParagraphRefShape);

// Assert the paragraph belongs to the spec (mirrors resolveIds in the REST layer):
// a nodeId naming a paragraph in a different spec must not be reachable through a
// spec-scoped tool. Returns a tool error to surface, or null when ownership holds.
async function assertParagraphInSpec(specId: string, nodeId: string): Promise<ToolResult | null> {
  const owner = await pool.query<{ spec_id: string }>(
    `SELECT spec_id FROM paragraphs WHERE id = $1`,
    [nodeId]
  );
  const specOfNode = owner.rows[0]?.spec_id;
  if (!specOfNode || specOfNode.toLowerCase() !== specId.toLowerCase()) {
    return toolError(`paragraph not found in spec: nodeId=${nodeId}`);
  }
  return null;
}

export async function handleListAssociations(args: unknown): Promise<ToolResult> {
  const parsed = ParagraphRef.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid list_associations input: specId and nodeId must be UUIDs');
  }
  const { specId, nodeId } = parsed.data;
  try {
    const guard = await assertParagraphInSpec(specId, nodeId);
    if (guard) return guard;
    const data = await listAssociationsForParagraph(nodeId);
    return ok(data);
  } catch (err) {
    logger.error({ err }, 'mcp tool list_associations failed');
    return toolError('Internal error — association list failed');
  }
}

// Path ids reused verbatim; the association body (with its DMS-pair/url cross-field
// rule) is validated by CreateAssociationBodySchema — the same schema the REST route
// uses — so the presence rule cannot drift between the two surfaces.
export const CreateAssociationShape = {
  ...ParagraphRefShape,
  ...CreateAssociationBodySchema.shape,
};

export async function handleCreateAssociation(args: unknown): Promise<ToolResult> {
  // Two-step parse by design (not collapsed into z.object(CreateAssociationShape)):
  // spreading CreateAssociationBodySchema.shape into CreateAssociationShape strips the
  // cross-field .check() (the DMS-pair/url presence rule), so the body MUST be parsed
  // against the full CreateAssociationBodySchema to keep that validation from silently
  // vanishing. The path ids are validated separately.
  const ref = ParagraphRef.safeParse(args);
  if (!ref.success) {
    return toolError('invalid create_association input: specId and nodeId must be UUIDs');
  }
  const body = CreateAssociationBodySchema.safeParse(args);
  if (!body.success) {
    return toolError(
      `invalid create_association input: ${body.error.issues.map((i) => i.message).join('; ')}`
    );
  }
  try {
    const guard = await assertParagraphInSpec(ref.data.specId, ref.data.nodeId);
    if (guard) return guard;
    const created = await createAssociation(ref.data.nodeId, body.data);
    return ok(created);
  } catch (err) {
    if (err instanceof AssociationParagraphNotFoundError) {
      return toolError(`paragraph not found: id=${ref.data.nodeId}`);
    }
    logger.error({ err }, 'mcp tool create_association failed');
    return toolError('Internal error — association create failed');
  }
}

export const DeleteAssociationShape = {
  ...ParagraphRefShape,
  associationId: z.uuid().describe('Association UUID to remove (from list_associations)'),
};
const DeleteAssociationArgs = z.object(DeleteAssociationShape);

export async function handleDeleteAssociation(args: unknown): Promise<ToolResult> {
  const parsed = DeleteAssociationArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid delete_association input: specId, nodeId, associationId must be UUIDs'
    );
  }
  const { specId, nodeId, associationId } = parsed.data;
  try {
    const guard = await assertParagraphInSpec(specId, nodeId);
    if (guard) return guard;
    // Hard DELETE of the link row (ADR-019 stores only link + provenance, never bytes) —
    // no soft-delete/restore, hence the destructive tier.
    const deleted = await deleteAssociation(nodeId, associationId);
    if (!deleted) return toolError(`association not found: id=${associationId}`);
    return ok({ deleted: true, associationId });
  } catch (err) {
    logger.error({ err }, 'mcp tool delete_association failed');
    return toolError('Internal error — association delete failed');
  }
}
