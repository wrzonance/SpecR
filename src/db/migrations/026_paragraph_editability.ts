import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * #134 (O-7): persist editability per paragraph as two nullable JSONB columns,
 * stored side by side and never merged (ADR-022 D2).
 *
 * - `classification`       — the machine's verdict (editability + confidence +
 *                            evidence), validated by ClassificationSchema.
 *                            NULL until the paragraph is classified.
 * - `editability_override` — the human's override, validated by OverrideSchema.
 *                            NULL = no override.
 *
 * Effective value = override ?? classification.editability. Re-classification
 * rewrites only `classification`; the override is untouched by construction.
 *
 * No NOT NULL / no default: unlike `source_facts` (023, defaults `{}` because
 * every paragraph HAS facts), not every paragraph is classified — NULL is the
 * honest "not yet classified" state. Shape is enforced by the closed Zod schemas
 * at the query boundary, not a CHECK constraint (hybrid validation, ADR-021).
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('paragraphs', {
    classification: { type: 'jsonb' },
    editability_override: { type: 'jsonb' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('paragraphs', ['editability_override', 'classification']);
};
