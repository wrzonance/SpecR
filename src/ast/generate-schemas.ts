import { z } from 'zod';
import { SectionNumberFormatSchema } from '../lib/section-number.js';
import { IssuanceModeSchema } from './revision-schemas.js';

export const GenerateBodySchema = z
  .object({
    templateId: z.uuid().exactOptional(),
    sectionNumberFormat: SectionNumberFormatSchema.exactOptional(),
    // ADR-079 (#406): same issuance-readiness gate as package-revision
    // creation. `draft`/omitted is a no-op; `final` enforces
    // `assertReadyForFinal` against the resolved tree(s) before generation.
    mode: IssuanceModeSchema.exactOptional(),
    overrideReadinessGate: z.boolean().exactOptional(),
  })
  // `.strict()` so a misspelled/unrecognized field (e.g. `mdoe` for `mode`)
  // fails validation instead of silently parsing as if the field were never
  // sent — bypassing the ADR-079 readiness gate with no error at all
  // (review finding, #406). `.extend()` (unlike spreading `.shape`) carries
  // this strict mode forward, so `RevisionGenerateBodySchema` still rejects
  // unknown keys while accepting its own added `baseRevisionId` field.
  .strict();

export type GenerateBody = z.infer<typeof GenerateBodySchema>;
