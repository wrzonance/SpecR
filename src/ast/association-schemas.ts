import { z } from 'zod';

// External content association request (#109). Presence rule mirrors the
// paragraph_associations CHECK: a complete DMS pair (externalProvider + externalId)
// OR a url must be provided. Link + provenance only — never the licensed bytes
// (ADR-019).
export const CreateAssociationBodySchema = z
  .object({
    label: z.string().trim().check(z.minLength(1)),
    externalProvider: z.string().trim().check(z.minLength(1)).exactOptional(),
    externalId: z.string().trim().check(z.minLength(1)).exactOptional(),
    url: z.url().exactOptional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'contentHash must be a sha256 hex digest')
      .exactOptional(),
    externalMetadata: z.record(z.string(), z.unknown()).exactOptional(),
  })
  .check((ctx) => {
    const { url, externalProvider, externalId } = ctx.value;
    const hasDmsPair = externalProvider !== undefined && externalId !== undefined;
    const hasUrl = url !== undefined;
    // The DMS pair is both-or-neither, independent of url: a lone externalProvider
    // or externalId is an unusable half-identity, even alongside a url (#242).
    if ((externalProvider !== undefined) !== (externalId !== undefined)) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'externalProvider and externalId must be provided together',
      });
    }
    if (!hasDmsPair && !hasUrl) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'provide a url, or both externalProvider and externalId',
      });
    }
  });

export type CreateAssociationBody = z.infer<typeof CreateAssociationBodySchema>;
