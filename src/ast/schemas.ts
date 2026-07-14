import { z } from 'zod';
import { SectionNumberInputSchema } from '../lib/section-number.js';
import { ActorLabelSchema } from './actor-schemas.js';

export const PatchSpecBodySchema = z.object({
  title: z.string().check(z.minLength(1)).exactOptional(),
  // PATCH must set a real section — the sentinel is not assignable by clients.
  section: SectionNumberInputSchema.exactOptional(),
});

// Individual paragraph update (ADR-009 / #47). Empty text is rejected so the
// Revit add-in (#48) can never blank a paragraph by pushing an empty value.
// `expectedVersion` is the optimistic-concurrency precondition (ADR-018 D1):
// the spec content_version the caller read. Optional for backward compatibility
// — when present, a stale value is rejected 409 with the current version.
export const UpdateParagraphBodySchema = z.object({
  text: z.string().check(z.minLength(1)),
  expectedVersion: z.number().int().min(1).exactOptional(),
  actorLabel: ActorLabelSchema.exactOptional(),
});

export type UpdateParagraphBody = z.infer<typeof UpdateParagraphBodySchema>;

// Advisory soft-lock acquire/release (ADR-018 D2). `holder` is a caller-supplied
// identity label until auth (#43) supplies an authenticated one. `ttlSeconds`
// caps at 1 hour so a single acquire can never wedge a spec for an unreasonable
// time before it is stealable; omitted → server default (15 min).
export const AcquireLockBodySchema = z.object({
  holder: z.string().check(z.minLength(1)),
  ttlSeconds: z.number().int().min(1).max(3600).exactOptional(),
});

export type AcquireLockBody = z.infer<typeof AcquireLockBodySchema>;

export const ReleaseLockBodySchema = z.object({
  holder: z.string().check(z.minLength(1)),
});

export type ReleaseLockBody = z.infer<typeof ReleaseLockBodySchema>;

export const CreateProjectBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
  description: z.string().check(z.minLength(1)).exactOptional(),
  // Ordered source list (priority = array order, 1-based). Required, min 1 —
  // section-resolution is the only way to add specs, so a sourceless project
  // would be a dead end (design doc #94).
  sourceLibraryIds: z
    .array(z.uuid())
    .check(z.minLength(1))
    .check((ctx) => {
      if (new Set(ctx.value).size !== ctx.value.length) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'sourceLibraryIds must not contain duplicates',
        });
      }
    }),
});

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const AddSectionToProjectBodySchema = z.object({
  // Tolerant input; normalized before the query layer sees it.
  section: SectionNumberInputSchema,
});

export type AddSectionToProjectBody = z.infer<typeof AddSectionToProjectBodySchema>;

// A project's ordered source libraries — a non-empty array of distinct library
// UUIDs. Shared by the REST route and the MCP tool (one source of truth).
export const SetProjectSourcesBodySchema = z.object({
  sourceLibraryIds: z
    .array(z.uuid())
    .check(z.minLength(1))
    .check((ctx) => {
      if (new Set(ctx.value).size !== ctx.value.length) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'sourceLibraryIds must not contain duplicates',
        });
      }
    }),
});

export type SetProjectSourcesBody = z.infer<typeof SetProjectSourcesBodySchema>;

export const SetDivisionGeneralSpecBodySchema = z
  .object({
    generalSpecId: z.uuid().exactOptional(),
    status: z.literal('not_applicable').exactOptional(),
    notes: z.string().check(z.minLength(1)).exactOptional(),
  })
  .check((ctx) => {
    const hasSpec = ctx.value.generalSpecId !== undefined;
    const notApplicable = ctx.value.status === 'not_applicable';
    if (hasSpec === notApplicable) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'provide either generalSpecId or status=not_applicable',
      });
    }
  });

export type SetDivisionGeneralSpecBody = z.infer<typeof SetDivisionGeneralSpecBodySchema>;

export const CreatePackageBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
});

export type CreatePackageBody = z.infer<typeof CreatePackageBodySchema>;

// Full-replacement ordered membership (position = array order, 1-based).
// Empty array clears the package. Same-project restriction is enforced at
// the query layer (ADR-015 D4, issue #95).
export const SetPackageSpecsBodySchema = z.object({
  specIds: z.array(z.uuid()).check((ctx) => {
    if (new Set(ctx.value).size !== ctx.value.length) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'specIds must not contain duplicates',
      });
    }
  }),
});

export type SetPackageSpecsBody = z.infer<typeof SetPackageSpecsBodySchema>;
