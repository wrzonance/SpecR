import { z } from 'zod';
import type { SpecNode, SourceFacts } from './types.js';
import { SectionNumberSchema } from '../lib/section-number.js';
import { textEndsWithClosed } from './comment-closure.js';
import { SignalNumberSchema, SpecNodeInferenceSchema } from './inference-schemas.js';
import { ActorLabelSchema } from './actor-schemas.js';
import { HeaderFooterCompositionSchema } from './header-footer-schemas.js';
import { ObjectMetaSchema } from './object-schemas.js';

export const NodeTypeSchema = z.enum([
  'spec',
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
  'note',
  'continuation',
  // Body-level DOCX object model (#300, ADR-072): a captured table/text-box
  // blob ('object') and the editable paragraph text extracted from its cells
  // ('objectText', an 'object' node's only children). Neither participates in
  // the 5-signal hierarchy engine or CSI numbering (see labels.ts consumesNumber).
  'object',
  'objectText',
]);

// Closed enum of recognized CSI article roles (ADR-033). Kebab-case values are
// stable identifiers consumed by coordination checks — not display labels.
export const ArticleRoleSchema = z.enum([
  'summary',
  'references',
  'definitions',
  'related-sections',
  'submittals',
  'quality-assurance',
  'delivery-storage-handling',
  'warranty',
]);

export const SignalConflictSchema = z.object({
  signal: SignalNumberSchema,
  reportedIlvl: z.number().int(),
  reportedNodeType: NodeTypeSchema,
});

// Catchall for unknown JSONB-backed keys: preserve only JSON-safe values.
const JsonValue = z.json();

const SourceTextSpanSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

export const SourceCommentFactSchema = z
  .object({
    author: z.string(),
    text: z.string(),
    anchor: SourceTextSpanSchema,
    // Closure state (#262). Optional for forward-compat: comments persisted before
    // this field existed (between #183 and #262) carry no `closed` flag.
    closed: z.boolean().optional(),
  })
  // Backfill the missing flag for legacy facts from the one closure signal that
  // survives in stored data — the trailing "Closed" suffix. (The strike-out
  // signal is parse-time-only and unrecoverable, so legacy struck-but-not-
  // suffixed comments still read as open.) New facts always carry an explicit
  // `closed`, so this only changes the absent case.
  .transform((c) => ({ ...c, closed: c.closed ?? textEndsWithClosed(c.text) }));

export const SourceColorFactSchema = z.object({
  color: z.string(),
  coverage: z.number().min(0).max(1),
  spans: z.array(SourceTextSpanSchema),
});

export const SourceHighlightFactSchema = z
  .object({
    color: z.string(),
    text: z.string(),
    span: SourceTextSpanSchema,
  })
  .catchall(JsonValue);

export const SourceChoiceTokenFactSchema = z.object({
  kind: z.enum(['angle', 'bracket']),
  options: z.array(z.string()),
  span: SourceTextSpanSchema,
});

const emphasisLocation = { text: z.string(), span: SourceTextSpanSchema };

export const SourceEmphasisFactSchema = z.discriminatedUnion('property', [
  z.object({
    property: z.literal('bold'),
    value: z.boolean(),
    expected: z.boolean(),
    ...emphasisLocation,
  }),
  z.object({
    property: z.literal('italic'),
    value: z.boolean(),
    expected: z.boolean(),
    ...emphasisLocation,
  }),
  z.object({
    property: z.literal('underline'),
    value: z.string(),
    expected: z.string(),
    ...emphasisLocation,
  }),
  z.object({
    property: z.literal('size'),
    value: z.number().int(),
    expected: z.number().int().nullable(),
    ...emphasisLocation,
  }),
]);

export const SourceFactsSchema = z
  .object({
    colors: z.array(SourceColorFactSchema).exactOptional(),
    highlights: z.array(SourceHighlightFactSchema).exactOptional(),
    comments: z.array(SourceCommentFactSchema).exactOptional(),
    choiceTokens: z.array(SourceChoiceTokenFactSchema).exactOptional(),
    emphasis: z.array(SourceEmphasisFactSchema).exactOptional(),
    banner: z.string().exactOptional(),
    vanish: z.literal(true).exactOptional(),
  })
  .catchall(JsonValue);

/**
 * Normalize raw `source_facts` JSONB read from the DB into the canonical shape
 * before it reaches an API response (#262). Crucially this backfills the
 * comment `closed` flag for legacy facts persisted before the field existed —
 * read paths that pass the raw JSONB through verbatim would otherwise emit
 * comment objects missing `closed`, violating the OpenAPI contract that now
 * requires it. A corrupt row fails loud here, never a silent drop.
 */
export function parseSourceFacts(raw: unknown): SourceFacts {
  return SourceFactsSchema.parse(raw ?? {});
}

// ── Editing conventions (ADR-022 D3) — library-scoped editability rulesets ──
// The closed four-value editability vocabulary (ADR-022 D1). Reused by the
// classification engine (O-6) and per-paragraph classification storage (O-7).
export const EditabilitySchema = z.enum(['locked', 'editable', 'choice', 'note']);

// One why-chain entry for an editability verdict (ADR-022 D4). Mirrors the
// `ClassificationEvidence` interface in conventions/types.ts. CLOSED (.strict()):
// this is our own engine output, not captured external data — a malformed entry
// is engine drift and must be rejected at the boundary, never silently kept.
export const ClassificationEvidenceSchema = z
  .object({
    rule: z.string().check(z.minLength(1)),
    fact: z.string().check(z.minLength(1)).exactOptional(),
    detail: z.string().check(z.minLength(1)).exactOptional(),
  })
  .strict();

export type ClassificationEvidence = z.infer<typeof ClassificationEvidenceSchema>;

// All convention sub-objects use `.catchall(JsonValue)` so unknown rule keys are
// preserved (ADR-022 D5 — open schema, capture-never-reject for round-trip).
const ColorMeaningSchema = z
  .object({ color: z.string(), meaning: EditabilitySchema })
  .catchall(JsonValue);

const HighlightMeaningSchema = z
  .object({ color: z.string(), meaning: EditabilitySchema })
  .catchall(JsonValue);

const ConventionChoiceTokenSchema = z
  .object({ kind: z.enum(['angle', 'bracket']) })
  .catchall(JsonValue);

const CommentPolicySchema = z.object({ treatAs: EditabilitySchema }).catchall(JsonValue);

// `noteBanners` are user-supplied regex SOURCES (strings). Shape-only here; their
// length/ReDoS safety is bounded at the WRITE boundary (ADR-022 D5 exception),
// never in this open read schema. See src/lib/regex-safety.ts.
export const ConventionRulesSchema = z
  .object({
    colorMeanings: z.array(ColorMeaningSchema).exactOptional(),
    highlightMeanings: z.array(HighlightMeaningSchema).exactOptional(),
    choiceTokens: z.array(ConventionChoiceTokenSchema).exactOptional(),
    noteBanners: z.array(z.string()).exactOptional(),
    comments: CommentPolicySchema.exactOptional(),
    defaultEditability: EditabilitySchema.exactOptional(),
  })
  .catchall(JsonValue);

export type Editability = z.infer<typeof EditabilitySchema>;
export type ConventionRules = z.infer<typeof ConventionRulesSchema>;

// Convention profile CRUD bodies (O-10). Structural-only: noteBanners regex
// length/ReDoS bounds are enforced at the WRITE boundary (query layer), which
// maps an unsafe pattern to 422 — never in this open shape schema.
export const PutConventionBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
  rules: ConventionRulesSchema.exactOptional(),
});

export type PutConventionBody = z.infer<typeof PutConventionBodySchema>;

export const CloneConventionBodySchema = z.object({
  sourceId: z.uuid(),
});

export type CloneConventionBody = z.infer<typeof CloneConventionBodySchema>;

// Effective editability surfaced on a classified paragraph (#134 / O-7). `value`
// is the effective verdict (override ?? machine); `confidence`/`evidence` are the
// machine's why-chain (kept readable even under an override, for the O-15
// machine-vs-human badge); `override` is present only when a human override exists.
export const SpecNodeEditabilitySchema = z.object({
  value: EditabilitySchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(ClassificationEvidenceSchema).check(z.minLength(1)),
  override: EditabilitySchema.exactOptional(),
});

// ── O-9 / #136 request bodies ────────────────────────────────────────────────
// Set the human override (closed enum) or clear it (explicit null). ADR-022 D2:
// override is a distinct field; clearing must be expressible in one call.
export const PatchEditabilityBodySchema = z.object({
  editability: EditabilitySchema.nullable(),
});

export type PatchEditabilityBody = z.infer<typeof PatchEditabilityBodySchema>;

// #251 — reversible paragraph removal. `removed: true` sets meta.vanish (suppress
// render, keep the row + subtree + refs); `false` reverses it. Distinct from a
// hard DELETE by design (ADR-022, symmetric with ADR-030 spec soft-delete).
export const PatchRemovalBodySchema = z.object({
  removed: z.boolean(),
  actorLabel: ActorLabelSchema.exactOptional(),
});

export type PatchRemovalBody = z.infer<typeof PatchRemovalBodySchema>;

// Reclassify input. `rules` (optional) supplies candidate rules for a preview;
// omitted → resolve the spec's library convention profile. `preview: true`
// computes the diff without persisting (preview-before-save). The rules schema
// is the open ADR-022 D5 ruleset — unknown keys preserved.
export const ReclassifyBodySchema = z.object({
  rules: ConventionRulesSchema.exactOptional(),
  preview: z.boolean().exactOptional(),
});

export type ReclassifyBody = z.infer<typeof ReclassifyBodySchema>;

export const SpecNodeMetaSchema = z.object({
  vanish: z.boolean().exactOptional(),
  source: z.enum(['ufgs', 'arcat', 'cpi', 'unknown']).exactOptional(),
  revitParam: z.string().exactOptional(),
  baseVersion: z.number().int().nonnegative().exactOptional(),
  conflicts: z.array(SignalConflictSchema).exactOptional(),
  inference: SpecNodeInferenceSchema.exactOptional(),
  sourceFacts: SourceFactsSchema.exactOptional(),
  editability: SpecNodeEditabilitySchema.exactOptional(),
  articleRole: ArticleRoleSchema.exactOptional(),
  object: ObjectMetaSchema.exactOptional(),
  pageBreakBefore: z.boolean().exactOptional(),
});

export const SpecNodeSchema: z.ZodType<SpecNode> = z.lazy(() =>
  z.object({
    id: z.uuid(),
    type: NodeTypeSchema,
    text: z.string().check(z.minLength(1)),
    children: z.array(SpecNodeSchema),
    meta: SpecNodeMetaSchema,
  })
);

export const SecRefSchema = z.discriminatedUnion('targetType', [
  z.object({
    sourceNodeId: z.uuid(),
    targetType: z.literal('section'),
    targetSpecSection: z.string().check(z.minLength(1)),
    standardCode: z.never().optional(),
    referenceText: z.string(),
  }),
  z.object({
    sourceNodeId: z.uuid(),
    targetType: z.literal('standard'),
    standardCode: z.string().check(z.minLength(1)),
    targetSpecSection: z.never().optional(),
    referenceText: z.string(),
  }),
]);

export const ParseWarningTypeSchema = z.enum([
  'root-continuation',
  'empty-part',
  'no-structure-found',
  'unusual-part-count',
  'non-conforming-part-numbering',
  'core-metadata-unreadable',
  'pdf-degraded-extraction',
  'pdf-ocr-applied',
  'pdf-ocr-low-confidence',
  'pdf-ocr-unusable',
  'pdf-font-encoding-remapped',
  'pdf-font-encoding-unrecoverable',
  'table-content-skipped',
  'header-footer-content-skipped',
  'body-drawing-skipped',
]);

export const ParseWarningSchema = z.object({
  type: ParseWarningTypeSchema,
  lineHint: z.string().exactOptional(),
  suggestion: z.string().exactOptional(),
});

// A DOCX table classified as hidden and retained out-of-band for future
// change-management (ADR-038, #293). Plain-text grid — no per-cell structure.
export const RetainedTableSchema = z.object({
  rows: z.array(z.array(z.string())),
});

export const SpecTreeSchema = z.object({
  id: z.uuid(),
  // Canonical expanded shape, or the 'unknown' sentinel emitted by parsers
  // when no section number is found (content inference may fill it later).
  section: z.union([SectionNumberSchema, z.literal('unknown')]),
  title: z.string().check(z.minLength(1)),
  parts: z.array(SpecNodeSchema),
  warnings: z.array(ParseWarningSchema).exactOptional(),
  hiddenTables: z.array(RetainedTableSchema).exactOptional(),
  // Captured DOCX header/footer composition (#306). Parse-output only in this
  // slice — no DB/REST/MCP persistence; see ADR-068.
  headerFooter: HeaderFooterCompositionSchema.exactOptional(),
});
