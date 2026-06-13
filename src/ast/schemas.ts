import { z } from 'zod';
import type { SpecNode } from './types.js';
import { SectionNumberSchema } from '../lib/section-number.js';

export const NodeTypeSchema = z.enum([
  'spec',
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'note',
  'continuation',
]);

export const SignalConflictSchema = z.object({
  signal: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  reportedIlvl: z.number().int(),
  reportedNodeType: NodeTypeSchema,
});

export const SpecNodeMetaSchema = z.object({
  vanish: z.boolean().exactOptional(),
  source: z.enum(['ufgs', 'arcat', 'cpi', 'unknown']).exactOptional(),
  revitParam: z.string().exactOptional(),
  baseVersion: z.number().int().nonnegative().exactOptional(),
  conflicts: z.array(SignalConflictSchema).exactOptional(),
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
  section: SectionNumberSchema.exactOptional(),
});

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
  // Canonical expanded-shape section number (lib/section-number.ts, ADR-020).
  section: SectionNumberSchema,
});

export type AddSectionToProjectBody = z.infer<typeof AddSectionToProjectBodySchema>;

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

const RequiredSectionInputSchema = z.object({
  section: SectionNumberSchema,
  title: z.string().check(z.minLength(1)).exactOptional(),
});

export const SetRequiredSectionsBodySchema = z.object({
  sections: z.array(RequiredSectionInputSchema).check((ctx) => {
    const sectionValues = ctx.value.map((item) => item.section);
    if (new Set(sectionValues).size !== sectionValues.length) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'sections must not contain duplicate section values',
      });
    }
  }),
});

export type SetRequiredSectionsBody = z.infer<typeof SetRequiredSectionsBodySchema>;

// Issuance label for an immutable package revision snapshot (ADR-015 D5):
// '50% DD', '100% CD', 'Addendum 2'. Unique per package, enforced by the DB.
export const CreateRevisionBodySchema = z.object({
  label: z.string().check(z.minLength(1)),
});

export type CreateRevisionBody = z.infer<typeof CreateRevisionBodySchema>;

// Body for PATCH /specs/:id/paragraphs/:paragraphId — the inline editor sends
// the full replacement body text for one paragraph.
export const UpdateParagraphBodySchema = z.object({
  text: z.string().check(z.minLength(1)),
});

export type UpdateParagraphBody = z.infer<typeof UpdateParagraphBodySchema>;

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
export const StyleNodeTypeSchema = z.enum(['part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5']);

// Catchall for unknown keys: any JSON value (string|number|boolean|null|array|object).
const JsonValue = z.json();

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
  name: z.string().check(z.minLength(1)),
  owner: z.string().check(z.minLength(1)).exactOptional(),
});

export type CreateTemplateBody = z.infer<typeof CreateTemplateBodySchema>;

export const PatchTemplateBodySchema = z
  .object({
    name: z.string().check(z.minLength(1)).exactOptional(),
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

// ── Generate request body (#32) ──────────────────────────────────────────────

export const GenerateBodySchema = z.object({
  templateId: z.uuid().exactOptional(),
});

export type GenerateBody = z.infer<typeof GenerateBodySchema>;
