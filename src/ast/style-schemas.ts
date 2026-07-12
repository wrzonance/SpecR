// Style-property, template-CRUD, and numbering-profile-CRUD request schemas,
// split from schemas.ts (#474) to keep that file within the max-lines budget.
import { z } from 'zod';
import { NumberingProfileSchema } from './numbering-profile-schema.js';

const JsonValue = z.json();

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
  // #318 — scope the template to a library; omit for a built-in / global template
  // (preserves the pre-#318 default where every created template was global).
  libraryId: z.uuid().exactOptional(),
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

export const PatchNumberingProfileBodySchema = z
  .object({
    name: z.string().trim().check(z.minLength(1)).exactOptional(),
    rules: NumberingProfileSchema.exactOptional(),
  })
  .check((ctx) => {
    if (ctx.value.name === undefined && ctx.value.rules === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'at least one of name or rules must be present',
      });
    }
  });

export type PatchNumberingProfileBody = z.infer<typeof PatchNumberingProfileBodySchema>;

// Assign an existing profile to a spec (#299).
export const SetSpecNumberingProfileBodySchema = z.object({
  profileId: z.uuid(),
});

export type SetSpecNumberingProfileBody = z.infer<typeof SetSpecNumberingProfileBodySchema>;
