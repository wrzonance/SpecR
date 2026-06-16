# ADR-018: Document Concurrency and State Model

## Status: Accepted (implemented in #107)

> **Implementation note (#107).** The composed edit gate (D3) reads
> `external_state`, which ADR-014 D5 places in core but schedules for Phase 7.
> To avoid the gate referencing a non-existent column, migration 025 adds the
> single `external_state` column now (closed enum, default `editable`), and the
> gate reads it. The rest of the ADR-014 external linkage (`external_provider` /
> `external_id` / `external_metadata` / `external_synced_at`) and the connector
> that *populates* `external_state` remain Phase 7 — core still never branches on
> a provider name. Advisory-lock `holder` is a caller-supplied label until auth
> (#43); meaningful for visibility, not enforcement, until then.

## Context

SpecR has no native concurrency control or document state. Two users editing the same
paragraph is last-write-wins with no detection. Nothing records that a spec is being
edited, has been issued, or should be frozen.

The DOCX cache issue (#52) sketches a narrow lock around cache regeneration. ADR-014 D5
adds `external_state` — governance mirrored from an upstream DMS. Multi-user operation
(Phase 5: auth #43, MCP write tools #44, web UI) needs the native counterpart.

One inherited constraint is non-negotiable: ADR-005 explicitly rejects locking a spec
while it is out for review — the 3-way merge exists precisely so design can continue
during review. This ADR must not reintroduce pessimistic checkout as the concurrency
model.

## Decision

Three small mechanisms, not one big lock:

### D1 — Optimistic concurrency on writes

Every content write (REST PATCH, MCP write tools) carries the `content_version`
(ADR-015) it read; on mismatch the write fails `409` with the current version.
Lost updates become impossible without any locking. Implementation: an
`If-Match`-style precondition or version field in the body — specified in `openapi.yaml`
before #44 builds against it.

### D2 — Advisory soft locks with TTL

```sql
CREATE TABLE spec_locks (
  spec_id     UUID PRIMARY KEY REFERENCES specs(id) ON DELETE CASCADE,
  holder      TEXT NOT NULL,                -- user/agent identity (auth, #43)
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
```

"Someone is editing this section" visibility for UI/MCP; writes by another holder while a
live lock exists are refused with the holder's identity in the error. TTL expiry means an
abandoned lock never wedges a spec — there is no unlock ceremony, only takeover after
expiry.

### D3 — A native lifecycle state, deliberately tiny

`specs.lifecycle_state ∈ { draft, issued, archived }`:

- `draft` — normal editing.
- `issued` — the spec participates in at least one package revision (set automatically at
  issuance, ADR-015 D5). Editing stays allowed — the *snapshot* is the immutable thing —
  but writes return an advisory: changes affect future issuances only.
- `archived` — read-only.

The edit gate composes native and external state: a write requires `lifecycle_state`
writable AND `external_state` (ADR-014) writable.

## Consequences

- REST/MCP write contracts change: writes carry a version precondition. #44 (MCP write
  tools) must be specified against this from the start. #52's cache invalidation keys off
  `content_version` instead of bespoke locking — #52 shrinks rather than grows.
- The enum stays closed and small — the ADR-014 lesson: process specifics never become new
  states. Richer workflow (multi-stage approvals) belongs to the upstream DMS via
  `external_state`, or to a future native approval feature with its own ADR.
- Pessimistic checkout/checkin was considered and rejected: it recreates the
  file-custody workflow SpecR exists to replace and contradicts ADR-005's
  review-without-freezing model.
- Soft locks are identity-dependent: before auth (#43) lands, `holder` is a
  caller-supplied label — adequate for trusted single-tenant deployments, meaningless for
  enforcement until authenticated identity exists. Sequenced with Phase 5.

## Related

- ADR-005 (no lock-during-review), ADR-014 D5 (`external_state` mirror), ADR-015
  (`content_version`, issuance), #43 (auth), #44 (MCP write tools), #52 (cache)
