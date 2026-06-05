import { z } from 'zod';
import type { SpecNode } from './types.js';

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
  section: z.string().regex(/^\d{2} \d{2} \d{2}$/),
  title: z.string().check(z.minLength(1)),
  parts: z.array(SpecNodeSchema),
  warnings: z.array(ParseWarningSchema).exactOptional(),
});

export const PatchSpecBodySchema = z.object({
  title: z.string().check(z.minLength(1)).exactOptional(),
  section: z
    .string()
    .regex(/^\d{2} \d{2} \d{2}$/)
    .exactOptional(),
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
