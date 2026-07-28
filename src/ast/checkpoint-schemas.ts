import { z } from 'zod';
import { ActorLabelSchema } from './actor-schemas.js';

// ADR-052 D3/D4/D6 (issue #380) — checkpoint creation and per-paragraph reject
// request bodies.

// Checkpoints require a real attributed actor: checkpoints.user_id is NOT NULL
// with ON DELETE RESTRICT (migration 052) — every checkpoint is created after
// the users table exists, so there is no SYSTEM_ACTOR_LABEL fallback the way
// an ordinary paragraph write has. actorLabel is therefore REQUIRED here,
// unlike its `.exactOptional()` use everywhere else.
export const CreateCheckpointBodySchema = z.object({
  // Trimmed BEFORE the length check so a whitespace-only name fails Zod (422)
  // rather than tripping the DB's checkpoints_name_nonempty CHECK as a pg
  // 23514 surfaced as 500 (same pattern as CreateTemplateBodySchema).
  name: z.string().trim().check(z.minLength(1)),
  actorLabel: ActorLabelSchema,
});

export type CreateCheckpointBody = z.infer<typeof CreateCheckpointBodySchema>;

// Per-paragraph reject (ADR-052 D4): revert a paragraph to the state it held
// at checkpointId's sealed contentVersion. actorLabel is optional here, like
// every other paragraph-write body — the revert is itself an ordinary history
// row and falls back to the SYSTEM_ACTOR_LABEL sentinel like any other
// unattributed write (see updateParagraphText).
export const RejectParagraphBodySchema = z.object({
  checkpointId: z.uuid(),
  actorLabel: ActorLabelSchema.exactOptional(),
});

export type RejectParagraphBody = z.infer<typeof RejectParagraphBodySchema>;
