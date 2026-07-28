import { z } from 'zod';
import { SectionNumberFormatSchema } from '../lib/section-number.js';
import { IssuanceModeSchema } from './revision-schemas.js';

export const GenerateBodySchema = z.object({
  templateId: z.uuid().exactOptional(),
  sectionNumberFormat: SectionNumberFormatSchema.exactOptional(),
  // ADR-079 (#406): same issuance-readiness gate as package-revision
  // creation. `draft`/omitted is a no-op; `final` enforces
  // `assertReadyForFinal` against the resolved tree(s) before generation.
  // Not `.strict()` (unlike the structured revision body) — `generate`
  // handlers accept exactly these declared fields either way, since
  // `RevisionGenerateBodySchema` extends this schema with `baseRevisionId`.
  mode: IssuanceModeSchema.exactOptional(),
  overrideReadinessGate: z.boolean().exactOptional(),
});

export type GenerateBody = z.infer<typeof GenerateBodySchema>;
