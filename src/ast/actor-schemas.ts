import { z } from 'zod';
import { UTF16_LENGTH_LIMIT_NOTE } from '../lib/length-limit-note.js';

// ── Actor attribution (#377 / ADR-052 D1) ────────────────────────────────────
// A caller-supplied identity label threaded through every paragraph/merge
// write so `paragraph_versions.user_id` resolves to a real row rather than
// leaving history attributed to nobody. Trimmed and rejected if it collapses
// to empty (trim BEFORE the length check, matching CreateTemplateBodySchema's
// whitespace-only-name guard, so a whitespace-only label fails Zod → 422
// rather than silently becoming ''). Bare (non-optional) by design — callers
// apply `.exactOptional()` at each embedding site (see EditabilitySchema for
// the same shared-base-schema pattern) so the inferred field type stays
// `actorLabel?: string`, never `actorLabel?: string | undefined`, which is
// what several call sites pass straight through as a whole-object argument
// under `exactOptionalPropertyTypes: true`. Omitted → the query layer falls
// back to the SYSTEM_ACTOR_LABEL sentinel; this schema never rejects a
// missing label.
// Bounded 1-200 to match users.label: an actorLabel resolves to a users row via
// resolveOrCreateUserByLabel, so it must obey the SAME 1-200 contract POST /users
// enforces (src/api/users.ts). Without the max, a >200-char actorLabel would mint a
// users row the public user API rejects, and GET /users would then surface a label it
// calls invalid. users.label is a bare `text` column (migration 045 CHECKs only
// non-empty), so this app-layer bound is the only thing enforcing the ceiling.
// The `.describe()` is not decoration: this schema is reused verbatim by six MCP
// tool shapes (update/insert/remove_paragraph, accept_comment_as_note, apply_merge,
// create_checkpoint), and the MCP SDK copies a declarative `z.maxLength(200)` into
// each tool's published JSON Schema as `maxLength: 200` — a keyword JSON Schema
// defines in Unicode code points while this check counts UTF-16 code units. The note
// travels with the bound so every generated tool schema documents the ADR-088
// divergence, matching what openapi.yaml states for the REST twin. Embedding sites
// that supply their own `.describe()` must append the note themselves (see
// MergeFieldsShape.actorLabel and AcceptCommentShape.actorLabel).
export const ActorLabelSchema = z
  .string()
  .trim()
  .check(z.minLength(1), z.maxLength(200))
  .describe(
    'Caller identity label attributed to this write in paragraph history; resolves to a ' +
      `users row and shares the POST /users 1-200 length contract. ${UTF16_LENGTH_LIMIT_NOTE}`
  );

// Accept-as-note (#251/#377) had no request body before #377 — the target
// comment is identified entirely by path params (nodeId, index). actorLabel
// is the schema's only field, so an omitted body is equivalent to `{}`.
export const AcceptNoteBodySchema = z.object({
  actorLabel: ActorLabelSchema.exactOptional(),
});

export type AcceptNoteBody = z.infer<typeof AcceptNoteBodySchema>;
