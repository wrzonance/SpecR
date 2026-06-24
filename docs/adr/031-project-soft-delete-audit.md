# ADR-031: Project deletion is soft (tombstone) and audited, not a hard delete

## Status

Accepted

## Context

`DELETE /projects/:id` did not exist; the only project lifecycle was create /
rename / re-source. Hard-deleting a project is dangerous: a project is the root
of a derivation tree — its `project_specs` clones carry `parent_spec_id` lineage
back to library masters (mig 019), and packages/revisions/required-sections all
hang off it. A destructive row delete would either cascade away that custody
trail or fail on a RESTRICT FK, and in both cases the action is irreversible.

ADR-030 already settled the analogous question for library masters: a spec is
**withdrawn** (tombstoned via `withdrawn_at`), not destroyed, so provenance is
preserved and the action is reversible. Projects deserve the same treatment, and
in addition want an **audit** dimension — _who_ removed the project, not just
_when_ — because a project is a shared, multi-stakeholder artifact.

There is no user / auth model in SpecR yet (#43 is deferred). So "who" cannot be
a foreign key to a `users` table that does not exist.

## Decision

`DELETE /projects/:id` performs a **soft delete (tombstone)**, mirroring ADR-030's
custody philosophy, and records an audit actor.

- Migration 034 adds two nullable columns to `projects`:
  `deleted_at timestamptz NULL` (NULL = active) and `deleted_by text NULL`.
- **Actor is caller-supplied free text** (request body `{ deletedBy }`, required,
  min length 1). Deliberately **no FK** — there is no user table yet (#43). When
  auth lands, the handler will populate `deletedBy` from the authenticated session
  instead of trusting the body; the column shape does not change.
- `DELETE /projects/:id` → `200 { projectId, deletedAt, deletedBy }`. Malformed id
  → `400`; missing/empty `deletedBy` → `400`; unknown project → `404`.
- **Idempotent re-delete:** deleting an already-deleted project returns `200` with
  the **existing** `deletedAt`/`deletedBy` (a `COALESCE` keep-first update) — the
  original audit record is never overwritten by a later actor.
- `POST /projects/:id/restore` clears `deleted_at` + `deleted_by` → `200`
  (reversible). Idempotent: restoring a non-deleted project is a `200` no-op.
  Malformed id → `400`; unknown project → `404`.
- **Read-path:** `GET /projects` filters `deleted_at IS NULL` (tombstoned projects
  are hidden from the list). `GET /projects/:id` still returns a soft-deleted
  project, surfacing `deletedAt`/`deletedBy`, so a restore decision and any
  lineage/history still resolve.
- **Audit = who (`deleted_by`) + when (`deleted_at`).**

## Consequences

- Project removal is reversible and leaves the derivation tree, packages, and
  lineage intact — aligned with ADR-030 (spec withdraw) and ADR-015 (chain of
  custody). No destructive cascade ships.
- Cost: two columns plus a `deleted_at IS NULL` filter on the project listing, and
  a restore path. Only the list read filters; resolution paths that key off a
  specific project id are unaffected.
- `deleted_by` is currently trustless free text — its integrity is only as good as
  the caller until auth (#43) lands. That is an accepted, explicitly-scoped gap,
  not an oversight; the audit column is in place so the trail exists from day one
  and tightens automatically when sessions arrive.
- No hard-delete escape hatch ships now; a true purge, if ever needed, is a
  separate custody-reviewed decision (same stance as ADR-030).
