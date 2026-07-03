import { z } from 'zod';
import type { SpecNode, SourceFacts } from './types.js';
import { SectionNumberInputSchema, SectionNumberSchema } from '../lib/section-number.js';
import { textEndsWithClosed } from './comment-closure.js';
import { NumberingProfileSchema } from './numbering-profile-schema.js';

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
  signal: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
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

export const SourceChoiceTokenFactSchema = z.object({
  kind: z.enum(['angle', 'bracket']),
  options: z.array(z.string()),
  span: SourceTextSpanSchema,
});

export const SourceFactsSchema = z
  .object({
    colors: z.array(SourceColorFactSchema).exactOptional(),
    comments: z.array(SourceCommentFactSchema).exactOptional(),
    choiceTokens: z.array(SourceChoiceTokenFactSchema).exactOptional(),
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
  sourceFacts: SourceFactsSchema.exactOptional(),
  editability: SpecNodeEditabilitySchema.exactOptional(),
  articleRole: ArticleRoleSchema.exactOptional(),
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
  'pdf-degraded-extraction',
  'pdf-ocr-applied',
  'pdf-ocr-low-confidence',
  'pdf-ocr-unusable',
  'pdf-font-encoding-remapped',
  'pdf-font-encoding-unrecoverable',
]);

export const ParseWarningSchema = z.object({
  type: ParseWarningTypeSchema,
  lineHint: z.string().exactOptional(),
  suggestion: z.string().exactOptional(),
});

export const SpecTreeSchema = z.object({
  id: z.uuid(),
  // Canonical expanded shape, or the 'unknown' sentinel emitted by parsers
  // when no section number is found (content inference may fill it later).
  section: z.union([SectionNumberSchema, z.literal('unknown')]),
  title: z.string().check(z.minLength(1)),
  parts: z.array(SpecNodeSchema),
  warnings: z.array(ParseWarningSchema).exactOptional(),
});

export const PatchSpecBodySchema = z.object({
  title: z.string().check(z.minLength(1)).exactOptional(),
  // PATCH must set a real section — the sentinel is not assignable by clients.
  section: SectionNumberInputSchema.exactOptional(),
});

// Individual paragraph update (ADR-009 / #47). Empty text is rejected so the
// Revit add-in (#48) can never blank a paragraph by pushing an empty value.
// `expectedVersion` is the optimistic-concurrency precondition (ADR-018 D1):
// the spec content_version the caller read. Optional for backward compatibility
// — when present, a stale value is rejected 409 with the current version.
export const UpdateParagraphBodySchema = z.object({
  text: z.string().check(z.minLength(1)),
  expectedVersion: z.number().int().min(1).exactOptional(),
});

export type UpdateParagraphBody = z.infer<typeof UpdateParagraphBodySchema>;

// Advisory soft-lock acquire/release (ADR-018 D2). `holder` is a caller-supplied
// identity label until auth (#43) supplies an authenticated one. `ttlSeconds`
// caps at 1 hour so a single acquire can never wedge a spec for an unreasonable
// time before it is stealable; omitted → server default (15 min).
export const AcquireLockBodySchema = z.object({
  holder: z.string().check(z.minLength(1)),
  ttlSeconds: z.number().int().min(1).max(3600).exactOptional(),
});

export type AcquireLockBody = z.infer<typeof AcquireLockBodySchema>;

export const ReleaseLockBodySchema = z.object({
  holder: z.string().check(z.minLength(1)),
});

export type ReleaseLockBody = z.infer<typeof ReleaseLockBodySchema>;

export const CreateProjectBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
  description: z.string().check(z.minLength(1)).exactOptional(),
  // Ordered source list (priority = array order, 1-based). Required, min 1 —
  // section-resolution is the only way to add specs, so a sourceless project
  // would be a dead end (design doc #94).
  sourceLibraryIds: z
    .array(z.uuid())
    .check(z.minLength(1))
    .check((ctx) => {
      if (new Set(ctx.value).size !== ctx.value.length) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'sourceLibraryIds must not contain duplicates',
        });
      }
    }),
});

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const AddSectionToProjectBodySchema = z.object({
  // Tolerant input; normalized before the query layer sees it.
  section: SectionNumberInputSchema,
});

export type AddSectionToProjectBody = z.infer<typeof AddSectionToProjectBodySchema>;

export const SetDivisionGeneralSpecBodySchema = z
  .object({
    generalSpecId: z.uuid().exactOptional(),
    status: z.literal('not_applicable').exactOptional(),
    notes: z.string().check(z.minLength(1)).exactOptional(),
  })
  .check((ctx) => {
    const hasSpec = ctx.value.generalSpecId !== undefined;
    const notApplicable = ctx.value.status === 'not_applicable';
    if (hasSpec === notApplicable) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'provide either generalSpecId or status=not_applicable',
      });
    }
  });

export type SetDivisionGeneralSpecBody = z.infer<typeof SetDivisionGeneralSpecBodySchema>;

export const CreatePackageBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
});

export type CreatePackageBody = z.infer<typeof CreatePackageBodySchema>;

// Full-replacement ordered membership (position = array order, 1-based).
// Empty array clears the package. Same-project restriction is enforced at
// the query layer (ADR-015 D4, issue #95).
export const SetPackageSpecsBodySchema = z.object({
  specIds: z.array(z.uuid()).check((ctx) => {
    if (new Set(ctx.value).size !== ctx.value.length) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'specIds must not contain duplicates',
      });
    }
  }),
});

export type SetPackageSpecsBody = z.infer<typeof SetPackageSpecsBodySchema>;

// ── Style properties (ADR-021): OOXML-faithful, OPEN (unknown JSON keys preserved) ──
// StyleNodeType is the subset of NodeType that carries visual style —
// excludes the structural-only 'spec' | 'note' | 'continuation'.
// Numeric fields are int-only with NO sign/range bound on purpose (ADR-021):
// we capture the author's value verbatim and warn at a higher layer rather
// than reject. Do not add .nonnegative()/.max() to them here.
// Each object uses `.catchall(JsonValue)` so unknown OOXML keys are preserved —
// but only as JSON values, matching the JSONB column. A non-JSON value (BigInt,
// function, symbol) is rejected at parse rather than silently dropped or thrown
// on JSON.stringify at the DB boundary.
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

const RunPropertiesSchema = z
  .object({
    rFonts: z
      .object({
        ascii: z.string().exactOptional(),
        hAnsi: z.string().exactOptional(),
        cs: z.string().exactOptional(),
        eastAsia: z.string().exactOptional(),
      })
      .catchall(JsonValue)
      .exactOptional(),
    sz: z.number().int().exactOptional(),
    b: z.boolean().exactOptional(),
    i: z.boolean().exactOptional(),
    caps: z.boolean().exactOptional(),
    smallCaps: z.boolean().exactOptional(),
    u: z.string().exactOptional(),
    strike: z.boolean().exactOptional(),
    // OOXML color token: 'RRGGBB' hex (e.g. 'FF0000') or 'auto'.
    color: z.string().exactOptional(),
    highlight: z.string().exactOptional(),
  })
  .catchall(JsonValue);

const ParagraphPropertiesSchema = z
  .object({
    spacing: z
      .object({
        before: z.number().int().exactOptional(),
        after: z.number().int().exactOptional(),
        line: z.number().int().exactOptional(),
        lineRule: z.enum(['auto', 'exact', 'atLeast']).exactOptional(),
        contextualSpacing: z.boolean().exactOptional(),
      })
      .catchall(JsonValue)
      .exactOptional(),
    ind: z
      .object({
        left: z.number().int().exactOptional(),
        right: z.number().int().exactOptional(),
        firstLine: z.number().int().exactOptional(),
        hanging: z.number().int().exactOptional(),
      })
      .catchall(JsonValue)
      .exactOptional(),
    jc: z.enum(['left', 'center', 'right', 'both', 'distribute', 'start', 'end']).exactOptional(),
  })
  .catchall(JsonValue);

const NumberingDefSchema = z
  .object({
    ilvl: z.number().int().exactOptional(),
    numFmt: z.string().exactOptional(),
    lvlText: z.string().exactOptional(),
    start: z.number().int().exactOptional(),
  })
  .catchall(JsonValue);

export const StylePropertiesSchema = z
  .object({
    rPr: RunPropertiesSchema.exactOptional(),
    pPr: ParagraphPropertiesSchema.exactOptional(),
    numbering: NumberingDefSchema.exactOptional(),
  })
  .catchall(JsonValue);

// ── Template CRUD request bodies ──────────────────────────────────────────────

export const CreateTemplateBodySchema = z.object({
  // name is trimmed BEFORE the length check so a whitespace-only name fails Zod
  // (→ 422 / tool validation error) rather than passing minLength(1) and later
  // tripping the DB's `length(trim(name)) > 0` CHECK as a pg 23514 surfaced as 500
  // (same pattern as CreateNumberingProfileBodySchema).
  name: z.string().trim().check(z.minLength(1)),
  owner: z.string().check(z.minLength(1)).exactOptional(),
});

export type CreateTemplateBody = z.infer<typeof CreateTemplateBodySchema>;

export const PatchTemplateBodySchema = z
  .object({
    // trimmed before the length check (see CreateTemplateBodySchema) so a
    // whitespace-only rename fails Zod rather than the DB CHECK.
    name: z.string().trim().check(z.minLength(1)).exactOptional(),
    // owner can be set to a string (non-empty) or null (to clear it).
    // exactOptional() would make `null` invalid — we want null to be a valid
    // explicit value when the key is present, but undefined when absent.
    owner: z.string().check(z.minLength(1)).nullable().optional(),
  })
  .check((ctx) => {
    if (ctx.value.name === undefined && ctx.value.owner === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'at least one of name or owner must be present',
      });
    }
  });

export type PatchTemplateBody = z.infer<typeof PatchTemplateBodySchema>;

const StyleRuleInputSchema = z.object({
  nodeType: StyleNodeTypeSchema,
  properties: StylePropertiesSchema,
});

export const UpsertStyleRulesBodySchema = z.object({
  rules: z.array(StyleRuleInputSchema).check(z.minLength(1)),
});

export type UpsertStyleRulesBody = z.infer<typeof UpsertStyleRulesBodySchema>;
export const SetStyleSourceBodySchema = z.object({
  templateId: z.uuid(),
});

export type SetStyleSourceBody = z.infer<typeof SetStyleSourceBodySchema>;

// ── Numbering profile CRUD request bodies (#299) ─────────────────────────────

// name is trimmed BEFORE the length check so a whitespace-only name fails Zod
// (→ 422) rather than passing minLength(1) and later tripping the DB's
// `length(trim(name)) > 0` CHECK as a pg 23514 the handler would surface as 500.
export const CreateNumberingProfileBodySchema = z.object({
  name: z.string().trim().check(z.minLength(1)),
  rules: NumberingProfileSchema,
});

export type CreateNumberingProfileBody = z.infer<typeof CreateNumberingProfileBodySchema>;

export const PatchNumberingProfileBodySchema = z.object({
  name: z.string().trim().check(z.minLength(1)).exactOptional(),
  rules: NumberingProfileSchema.exactOptional(),
});

export type PatchNumberingProfileBody = z.infer<typeof PatchNumberingProfileBodySchema>;

// Assign an existing profile to a spec (#299).
export const SetSpecNumberingProfileBodySchema = z.object({
  profileId: z.uuid(),
});

export type SetSpecNumberingProfileBody = z.infer<typeof SetSpecNumberingProfileBodySchema>;
