// Zod boundary schemas mirroring the subset of openapi.yaml this harness's
// API client actually calls: POST /parse, GET /parse/jobs/{jobId},
// POST /templates/import, POST /specs/{id}/generate (#150).
//
// Deliberately standalone, same as errors.ts and config.ts: tools/verify is
// an isolated pnpm package (see pnpm-workspace.yaml) with zero runtime
// dependency on src/. These are hand-mirrored copies of the real API
// contract, not imports of src/ast's schemas — keep them in sync with
// openapi.yaml by hand when either side changes.
//
// PropertyDecisionSchema.rejected is an array of `{ value, count }` losing
// candidates (spike finding 3) — NOT a boolean. Confirmed against both
// openapi.yaml's PropertyDecision schema and the real derive-template.ts
// implementation (src/parser/docx/derive-template.ts).

import * as z from 'zod';

// ─── Envelope shapes (openapi.yaml SuccessResponse / ErrorResponse) ───────────

export function successResponseSchema<Data extends z.ZodTypeAny>(
  data: Data
): z.ZodObject<{ success: z.ZodLiteral<true>; data: Data }> {
  return z.object({ success: z.literal(true), data });
}

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ─── Parse (POST /parse, GET /parse/jobs/{jobId}) ─────────────────────────────

export const ParseStageSchema = z.enum([
  'queued',
  'running',
  'extracting',
  'numbering',
  'styles',
  'document',
  'classifying',
  'persisting',
  'complete',
  'failed',
]);

export type ParseStage = z.infer<typeof ParseStageSchema>;

// Informational only — `type` is not narrowed to openapi's full enum so a
// new warning type added server-side doesn't break this client's parsing.
export const ParseWarningSchema = z.object({
  type: z.string(),
  lineHint: z.string().exactOptional(),
  suggestion: z.string().exactOptional(),
});

export const ParseJobResultSchema = z.object({
  specId: z.uuid(),
  section: z.string(),
  title: z.string(),
  nodeCount: z.number().int(),
  capabilities: z.array(z.string()).exactOptional(),
  warnings: z.array(ParseWarningSchema).exactOptional(),
});

export type ParseJobResult = z.infer<typeof ParseJobResultSchema>;

export const ParseJobSchema = z.object({
  jobId: z.uuid(),
  status: ParseStageSchema,
  progress: z.object({
    stage: ParseStageSchema,
    pct: z.number().min(0).max(100),
  }),
  result: ParseJobResultSchema.exactOptional(),
  error: z.string().exactOptional(),
  expiresAt: z.number().int(),
});

export type ParseJob = z.infer<typeof ParseJobSchema>;

export const ParseUploadResponseSchema = successResponseSchema(z.object({ jobId: z.uuid() }));

export const ParseJobResponseSchema = successResponseSchema(ParseJobSchema);

// ─── Templates (POST /templates/import) ───────────────────────────────────────

export const StyleNodeTypeSchema = z.enum([
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
]);

export type StyleNodeType = z.infer<typeof StyleNodeTypeSchema>;

// additionalProperties: true at every level in openapi.yaml — unknown OOXML
// keys are preserved (ADR-021), so this is a loose catchall, not a literal
// mirror of every recognized rPr/pPr/numbering leaf.
export const StylePropertiesSchema = z.object({}).catchall(z.json());

export const StyleRuleSchema = z.object({
  nodeType: StyleNodeTypeSchema,
  properties: StylePropertiesSchema,
});

export const TemplateMetaSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  owner: z.string().nullable(),
  libraryId: z.uuid().nullable(),
  createdAt: z.string(),
});

export const TemplateSchema = TemplateMetaSchema.extend({
  rules: z.array(StyleRuleSchema),
});

export type Template = z.infer<typeof TemplateSchema>;

const DecisionSourceSchema = z.enum(['consensus', 'intent', 'median', 'single', 'mode']);

const RejectedValueSchema = z.object({
  value: z.unknown(),
  count: z.number().int(),
});

// The spike-corrected shape (struct #9): an array of losing candidate
// values with vote counts, not a boolean.
export const PropertyDecisionSchema = z.object({
  path: z.string(),
  value: z.unknown(),
  source: DecisionSourceSchema,
  confidence: z.number().min(0).max(1),
  disagreesWithIntent: z.boolean(),
  rejected: z.array(RejectedValueSchema),
});

export type PropertyDecision = z.infer<typeof PropertyDecisionSchema>;

export const NodeTypeReportSchema = z.object({
  nodeType: StyleNodeTypeSchema,
  paragraphCount: z.number().int(),
  styledCount: z.number().int(),
  modalStyleId: z.string().nullable(),
  decisions: z.array(PropertyDecisionSchema),
});

export const DerivationReportSchema = z.object({
  nodeTypes: z.array(NodeTypeReportSchema),
  skippedNodeTypes: z.array(StyleNodeTypeSchema),
  vanishSkipped: z.number().int(),
});

export type DerivationReport = z.infer<typeof DerivationReportSchema>;

export const TemplateImportDataSchema = z.object({
  template: TemplateSchema,
  report: DerivationReportSchema,
});

export type TemplateImportData = z.infer<typeof TemplateImportDataSchema>;

export const TemplateImportResponseSchema = successResponseSchema(TemplateImportDataSchema);

// ─── Generate (POST /specs/{id}/generate) ─────────────────────────────────────
// The 200 response is a raw DOCX byte stream, not JSON — validated in
// client.ts via Content-Type + zip-magic check, not a Zod schema.

export const SectionNumberFormatSchema = z.enum(['canonical', 'dots', 'compact', 'spaced-compact']);

export type SectionNumberFormat = z.infer<typeof SectionNumberFormatSchema>;
