import { z } from 'zod';
import type { CsiNode } from './types.js';

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

export const CsiNodeMetaSchema = z.object({
  vanish: z.boolean().exactOptional(),
  source: z.enum(['ufgs', 'arcat', 'masterspec', 'unknown']).exactOptional(),
  revitParam: z.string().exactOptional(),
  baseVersion: z.number().int().nonnegative().exactOptional(),
});

export const CsiNodeSchema: z.ZodType<CsiNode> = z.lazy(() =>
  z.object({
    id: z.uuid(),
    type: NodeTypeSchema,
    text: z.string().check(z.minLength(1)),
    children: z.array(CsiNodeSchema),
    meta: CsiNodeMetaSchema,
  })
);

export const CsiTreeSchema = z.object({
  id: z.uuid(),
  section: z.string().regex(/^\d{2} \d{2} \d{2}$/),
  title: z.string().check(z.minLength(1)),
  parts: z.array(CsiNodeSchema),
});

export const PatchSpecBodySchema = z.object({
  title: z.string().check(z.minLength(1)).exactOptional(),
  section: z
    .string()
    .regex(/^\d{2} \d{2} \d{2}$/)
    .exactOptional(),
});
