import { z } from 'zod';

// Catchall for unknown JSONB-backed keys: preserve only JSON-safe values.
// Revision profiles store open JSONB (ADR-021), so unknown keys must round-trip.
const JsonValue = z.json();

// ── Revision nomenclature profiles (ADR-025 / #209) ──────────────────────────
// Project-scoped, user-defined taxonomy and templates. Every nested object stays
// open so future dashboard/header-footer keys round-trip through JSONB.
export const RevisionDateSchema = z.iso.date();

const RevisionTypeFormatSchema = z
  .object({
    displayName: z.string().check(z.minLength(1)).exactOptional(),
    number: z.string().check(z.minLength(1)).exactOptional(),
  })
  .catchall(JsonValue);

const RevisionTypeFieldSchema = z
  .object({
    key: z.string().check(z.minLength(1)),
    kind: z.enum(['string', 'integer', 'number', 'date', 'boolean', 'json']).exactOptional(),
    required: z.boolean().exactOptional(),
    sequence: z.string().check(z.minLength(1)).exactOptional(),
  })
  .catchall(JsonValue);

export const RevisionNomenclatureTypeSchema = z
  .object({
    key: z.string().check(z.minLength(1)),
    name: z.string().check(z.minLength(1)).exactOptional(),
    format: RevisionTypeFormatSchema.exactOptional(),
    fields: z.array(RevisionTypeFieldSchema).exactOptional(),
  })
  .catchall(JsonValue);

export const RevisionNomenclatureTypesSchema = z
  .array(RevisionNomenclatureTypeSchema)
  .check((ctx) => {
    const keys = ctx.value.map((type) => type.key);
    if (new Set(keys).size !== keys.length) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'revision type keys must not contain duplicates',
      });
    }
  });

export type RevisionNomenclatureType = z.infer<typeof RevisionNomenclatureTypeSchema>;
export type RevisionNomenclatureTypes = z.infer<typeof RevisionNomenclatureTypesSchema>;

export const PutRevisionNomenclatureBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
  types: RevisionNomenclatureTypesSchema,
});

export type PutRevisionNomenclatureBody = z.infer<typeof PutRevisionNomenclatureBodySchema>;

export const CloneRevisionNomenclatureBodySchema = z.object({
  sourceId: z.uuid(),
});

export type CloneRevisionNomenclatureBody = z.infer<typeof CloneRevisionNomenclatureBodySchema>;

export const RevisionAttributesSchema = z
  .object({
    number: z.union([z.string().check(z.minLength(1)), z.number()]).exactOptional(),
    title: z.string().check(z.minLength(1)).exactOptional(),
    phase: z.string().check(z.minLength(1)).exactOptional(),
  })
  .catchall(JsonValue);

export type RevisionAttributes = z.infer<typeof RevisionAttributesSchema>;

// Immutable package revision snapshot (ADR-015 D5 + ADR-025). The legacy label
// body remains accepted; structured writes use a profile-defined type plus an
// open attributes bag.
const LegacyCreateRevisionBodySchema = z
  .object({
    label: z.string().check(z.minLength(1)),
  })
  .strict();

// Exported so the MCP tool advertises + validates exactly the structured revision
// fields (the legacy label form is deprecated and intentionally not agent-exposed).
export const StructuredCreateRevisionBodySchema = z
  .object({
    type: z.string().check(z.minLength(1)),
    date: RevisionDateSchema.exactOptional(),
    sortOrder: z.number().int().positive().exactOptional(),
    attributes: RevisionAttributesSchema.exactOptional(),
    // ADR-066 (#389): the revision this one was issued FROM (git-tag-like
    // custody). Cross-package / nesting-depth / existence rules are enforced
    // by the query layer (assertValidParentRevision) — this only pins the
    // shape at the API boundary.
    parentRevisionId: z.uuid().exactOptional(),
    // ADR-066 (#390): immutable comparison lineage for reproducible addenda.
    // Existence and same-package rules are enforced transactionally at write.
    baseRevisionId: z.uuid().exactOptional(),
  })
  .strict();

export type StructuredCreateRevisionBody = z.infer<typeof StructuredCreateRevisionBodySchema>;

export const CreateRevisionBodySchema = z.union([
  LegacyCreateRevisionBodySchema,
  StructuredCreateRevisionBodySchema,
]);

export type CreateRevisionBody = z.infer<typeof CreateRevisionBodySchema>;
