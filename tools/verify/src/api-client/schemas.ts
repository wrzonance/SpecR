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

// ─── Header/footer fixture harness (#305) ─────────────────────────────────────
// Not consumed anywhere yet — library-client.ts and project-client.ts (task
// 2/7) drive the library-import and project-provisioning calls that parse
// against these. Kept here rather than in client.ts's schema imports so
// this file stays the single hand-mirrored copy of the openapi.yaml
// response shapes the harness actually calls, per this file's own opening
// docstring.

export const LibrarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

export type Library = z.infer<typeof LibrarySchema>;

export const ProjectSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

// Library-import jobs use a different terminal-status vocabulary than parse
// jobs (ParseStageSchema above) — deliberately its own enum, not reused,
// per the spike's struct #5 correction: an onboarding job never reports
// ParseStageSchema's fine-grained parse sub-stages ('extracting',
// 'numbering', ...).
export const OnboardingStageSchema = z.enum([
  'queued',
  'uploading',
  'parsing',
  'deriving',
  'validating',
  'persisting',
  'complete',
  'failed',
]);

export type OnboardingStage = z.infer<typeof OnboardingStageSchema>;

export const OnboardingJobResultSchema = z.object({
  templateId: z.uuid().nullable(),
  report: DerivationReportSchema,
});

export type OnboardingJobResult = z.infer<typeof OnboardingJobResultSchema>;

export const OnboardingJobSchema = z.object({
  jobId: z.uuid(),
  status: OnboardingStageSchema,
  progress: z.object({
    stage: OnboardingStageSchema,
    pct: z.number().min(0).max(100),
  }),
  result: OnboardingJobResultSchema.exactOptional(),
  error: z.string().exactOptional(),
  expiresAt: z.number().int(),
});

export type OnboardingJob = z.infer<typeof OnboardingJobSchema>;

// additionalProperties: true in openapi.yaml, same posture as
// StylePropertiesSchema above — this harness only round-trips what it
// itself PUT via putProjectHeaderFooter, never interprets an
// externally-authored config.
export const HeaderFooterConfigSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  config: z.object({}).catchall(z.json()),
});

export type HeaderFooterConfig = z.infer<typeof HeaderFooterConfigSchema>;

export const AddSectionToProjectResultSchema = z.object({
  projectSpecId: z.uuid(),
  specId: z.uuid(),
});

export type AddSectionToProjectResult = z.infer<typeof AddSectionToProjectResultSchema>;
