# ADR-051: Style-template library scoping

## Status

Accepted (2026-07-04).

## Context

Issue #317 closed a custody hole for **numbering profiles**: a spec could be
assigned a numbering profile owned by a *different* library, which hid the spec
from that library's scoped views and blocked the owning library's deletion via
the RESTRICT FK. The fix (migration 038, `setSpecNumberingProfile`) scopes the
assignment to the built-in default (`library_id IS NULL`) or a profile owned by
the spec's own library.

`style_templates` (migration 010, spec link in 027) had the identical assignment
surface — `setSpecStyleSource` — but **no `library_id` column at all**: templates
carried only a free-text `owner` label, so there was nothing to enforce against.
A library-A style template could be bound to a library-B spec exactly as the
numbering bug allowed. Issue #318 is the style half of #317.

The custody model to join is ADR-015's library-scoped ownership: profiles and
templates belong to a library, with a NULL scope reserved for shared built-ins.

## Decision

Add a nullable `library_id uuid references libraries(id) on delete cascade` to
`style_templates` (migration 039) and enforce it on assignment, mirroring the
numbering precedent exactly:

- **Scope predicate in the UPDATE.** `setSpecStyleSource` returns a discriminated
  union `'assigned' | 'spec-not-found' | 'library-mismatch'`. The UPDATE's WHERE
  carries `AND EXISTS (SELECT 1 FROM style_templates t WHERE t.id = $2 AND
  (t.library_id IS NULL OR t.library_id = s.library_id))`, so a cross-library
  assignment matches zero rows atomically. A no-op then distinguishes a missing
  spec (→ 404) from a scope rejection (→ 409) via a follow-up existence check.
- **Backfill as built-in default (NULL).** Existing rows — the seeded
  `UFGS-Default` and every per-spec `onboarded:*` template — backfill to
  `library_id NULL`, preserving today's global visibility. `addColumns` leaves
  them NULL implicitly; no data statement is needed.
- **NO builtin-singleton unique index.** Numbering's migration 038 adds a
  `library_id IS NULL` singleton index because there is exactly one built-in CSI
  Default. Style templates deliberately omit it: multiple rows are legitimately
  `library_id NULL` at once (the seeded default **plus** each per-spec onboarded
  template), so a singleton index would be violated on the first onboarding.
- **Project-spec policy: built-in-only.** A PROJECT spec has `library_id NULL`
  (the `specs_owner_xor` constraint), so the scope predicate admits only built-in
  templates for it — identical to the numbering precedent. No separate project-spec
  policy is invented.
- **Onboarded templates belong to the spec's library.** `upsertOnboardedTemplate`
  now creates the derived template with `library_id = the spec's library_id`
  (not NULL), so an onboarded template is scoped to its library rather than being
  a global built-in. Without this the assignment guard could never bind an
  onboarded template to a non-default library.
- **Handlers set the 409 themselves.** The REST `setStyleSourceHandler` and the
  MCP `handleAssignStyleSource` switch on the union — `spec-not-found` → 404,
  `library-mismatch` → 409, `assigned` → 200 — returning a plain
  `{ success: false, error }` at the handler (the error middleware only maps
  `.status` on thrown boundary errors), matching numbering's 409 shape.
- **Create carries scope.** `createTemplate` / `createTemplateWithRules` accept an
  optional `libraryId` (default NULL). `POST /templates` gains an optional
  `libraryId` body field; a libraryId for a non-existent library surfaces as a
  pg 23503 FK violation → 404.

## Consequences

- The numbering and style custody surfaces are now symmetric; a future reader can
  reason about one and trust the other. `TemplateMeta.libraryId` is exposed on
  every template read (REST + MCP).
- **List-scoping is a deferred follow-up.** `listTemplates` and
  `getTemplateByName` keep their current **global** behavior — they do not filter
  by library. The security fix in #318 is the *assignment* guard, not list
  filtering; a spec can no longer be bound to a foreign template regardless of
  what listing shows. Scoping the listing (and a `GET /libraries/{id}/templates`
  route mirroring numbering's list route) is left to a later slice.
- Migration 039 is reversible (drop index + column); no built-in seed row is
  added or removed, so the down migration is a clean structural revert.
