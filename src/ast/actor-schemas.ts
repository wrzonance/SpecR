import { z } from 'zod';
import { codePointMax } from '../lib/length-limit.js';
import { MAX_LABEL_LENGTH } from '../lib/label-length.js';

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
// Bounded 1-200 (Unicode code points, #642/ADR-091) to match users.label: an
// actorLabel resolves to a users row via resolveOrCreateUserByLabel, so it
// must obey the SAME 1-200 contract POST /users enforces (src/api/users.ts;
// MAX_LABEL_LENGTH lives in src/lib/label-length.ts so both surfaces — and
// the MCP twin, src/mcp/users-handlers.ts — share one number). Without the
// max, a >200-code-point actorLabel would mint a users row the public user
// API rejects, and GET /users would then surface a label it calls invalid.
// users.label is a bare `text` column (migration 045 CHECKs only non-empty),
// so this app-layer bound is the only thing enforcing the ceiling.
// The `.describe()` is not decoration: this schema is reused verbatim by six
// MCP tool shapes (update/insert/remove_paragraph, accept_comment_as_note,
// apply_merge, create_checkpoint), and the MCP SDK copies the `.meta()`
// `maxLength` codePointMax publishes into each tool's generated JSON
// Schema. Embedding sites that supply their own `.describe()` override
// (MergeFieldsShape.actorLabel, AcceptCommentShape.actorLabel) still inherit
// the maxLength/marker — only the description text changes.
export const ActorLabelSchema = codePointMax(
  z.string().trim().check(z.minLength(1)),
  MAX_LABEL_LENGTH,
  {
    description:
      'Caller identity label attributed to this write in paragraph history; resolves to a ' +
      `users row and shares the POST /users 1-${MAX_LABEL_LENGTH} length contract (Unicode code points).`,
  }
);

// Accept-as-note (#251/#377) had no request body before #377 — the target
// comment is identified entirely by path params (nodeId, index). actorLabel
// is the schema's only field, so an omitted body is equivalent to `{}`.
export const AcceptNoteBodySchema = z.object({
  actorLabel: ActorLabelSchema.exactOptional(),
});

export type AcceptNoteBody = z.infer<typeof AcceptNoteBodySchema>;
