import { z } from 'zod';
import { ActorLabelSchema } from './actor-schemas.js';

// Paragraph insertion (#372). The node types a caller may create: body
// paragraphs, articles, and continuations. Never 'part' (a CSI section keeps
// its three-part shape), never 'note' (notes materialize via accept-as-note
// with provenance), never 'spec'.
export const InsertableNodeTypeSchema = z.enum([
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
  'continuation',
]);

export type InsertableNodeType = z.infer<typeof InsertableNodeTypeSchema>;

// Insert a sibling paragraph immediately after `anchorNodeId` (#372 — the
// WYSIWYG Enter gesture; the merge engine's added-op apply, #374, shares this
// primitive). `nodeType` defaults server-side to the anchor's own type — a
// default outside the insertable set (anchor is a part or note) is rejected
// 422 so the caller must choose explicitly. Empty text is rejected like
// UpdateParagraphBodySchema; `expectedVersion` is the ADR-018 precondition.
export const InsertParagraphBodySchema = z.object({
  anchorNodeId: z.uuid(),
  text: z.string().check(z.minLength(1)),
  nodeType: InsertableNodeTypeSchema.exactOptional(),
  expectedVersion: z.number().int().min(1).exactOptional(),
  actorLabel: ActorLabelSchema.exactOptional(),
});

export type InsertParagraphBody = z.infer<typeof InsertParagraphBodySchema>;
