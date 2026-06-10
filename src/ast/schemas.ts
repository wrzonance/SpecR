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

export const SpecNodeMetaSchema = z.object({
  vanish: z.boolean().exactOptional(),
  source: z.enum(['ufgs', 'arcat', 'cpi', 'unknown']).exactOptional(),
  revitParam: z.string().exactOptional(),
  baseVersion: z.number().int().nonnegative().exactOptional(),
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
});

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const AddSpecToProjectBodySchema = z.object({
  specId: z.uuid(),
});

export type AddSpecToProjectBody = z.infer<typeof AddSpecToProjectBodySchema>;

// ── Style properties (ADR-021): OOXML-faithful, OPEN (unknown keys preserved) ──
// StyleNodeType is the subset of NodeType that carries visual style —
// excludes the structural-only 'spec' | 'note' | 'continuation'.
// Numeric fields are int-only with NO sign/range bound on purpose (ADR-021):
// we capture the author's value verbatim and warn at a higher layer rather
// than reject — `z.looseObject` already preserves unknown keys. Do not add
// .nonnegative()/.max() here.
export const StyleNodeTypeSchema = z.enum(['part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5']);

const RunPropertiesSchema = z.looseObject({
  rFonts: z
    .looseObject({
      ascii: z.string().exactOptional(),
      hAnsi: z.string().exactOptional(),
      cs: z.string().exactOptional(),
      eastAsia: z.string().exactOptional(),
    })
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
});

const ParagraphPropertiesSchema = z.looseObject({
  spacing: z
    .looseObject({
      before: z.number().int().exactOptional(),
      after: z.number().int().exactOptional(),
      line: z.number().int().exactOptional(),
      lineRule: z.enum(['auto', 'exact', 'atLeast']).exactOptional(),
      contextualSpacing: z.boolean().exactOptional(),
    })
    .exactOptional(),
  ind: z
    .looseObject({
      left: z.number().int().exactOptional(),
      right: z.number().int().exactOptional(),
      firstLine: z.number().int().exactOptional(),
      hanging: z.number().int().exactOptional(),
    })
    .exactOptional(),
  jc: z.enum(['left', 'center', 'right', 'both', 'distribute', 'start', 'end']).exactOptional(),
});

const NumberingDefSchema = z.looseObject({
  ilvl: z.number().int().exactOptional(),
  numFmt: z.string().exactOptional(),
  lvlText: z.string().exactOptional(),
  start: z.number().int().exactOptional(),
});

export const StylePropertiesSchema = z.looseObject({
  rPr: RunPropertiesSchema.exactOptional(),
  pPr: ParagraphPropertiesSchema.exactOptional(),
  numbering: NumberingDefSchema.exactOptional(),
});
