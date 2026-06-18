import { z } from 'zod';
import { SectionNumberFormatSchema } from '../lib/section-number.js';

export const GenerateBodySchema = z.object({
  templateId: z.uuid().exactOptional(),
  sectionNumberFormat: SectionNumberFormatSchema.exactOptional(),
});

export type GenerateBody = z.infer<typeof GenerateBodySchema>;
