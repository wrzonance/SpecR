import { z } from 'zod';

export const SubmittalRegisterBodySchema = z
  .object({
    specIds: z.array(z.uuid()),
  })
  .check((ctx) => {
    const ids = ctx.value.specIds;
    if (new Set(ids).size !== ids.length) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'specIds must not contain duplicates',
      });
    }
  });

export type SubmittalRegisterBody = z.infer<typeof SubmittalRegisterBodySchema>;
