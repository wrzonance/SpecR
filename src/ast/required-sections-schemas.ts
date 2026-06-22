import { z } from 'zod';
import { SectionNumberInputSchema } from '../lib/section-number.js';

const RequiredSectionEntrySchema = z.object({
  section: SectionNumberInputSchema,
  title: z.string().check(z.minLength(1)).exactOptional(),
});

const SeedFromSchema = z.union([
  z.literal('baseline'),
  z.literal('toc'),
  z.object({ packageId: z.uuid() }),
]);

export const RequiredSectionsBodySchema = z
  .object({
    sections: z.array(RequiredSectionEntrySchema).exactOptional(),
    seedFrom: SeedFromSchema.exactOptional(),
  })
  .check((ctx) => {
    if (ctx.value.sections !== undefined && ctx.value.seedFrom !== undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'provide either sections or seedFrom, not both',
      });
    }
    const sections = ctx.value.sections;
    if (sections && new Set(sections.map((s) => s.section)).size !== sections.length) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'sections must not contain duplicates',
      });
    }
  });

export type RequiredSectionsBody = z.infer<typeof RequiredSectionsBodySchema>;
