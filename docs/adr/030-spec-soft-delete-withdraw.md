# ADR-030: Spec deletion is soft (withdraw / tombstone), not a hard delete

## Status

Accepted

## Context

The demo's `specDelete` capability and the mockup island's `DELETE /specs/:id`
both modelled removing a library master as a hard row delete (cascade
paragraphs/refs; 409 if pinned). Under `main`'s copy model that test is wrong:
ownership is XOR (`specs.library_id` master XOR `specs.project_id` copy, mig 016),
and project membership is a separate clone row whose `parent_spec_id` points back
to the master (mig 019). A master with any clone already cannot be hard-deleted
(`parent_spec_id` FK is NO ACTION). More fundamentally, ADR-015's thesis is
layered-spec-hierarchy _chain-of-custody_: hard-deleting a master destroys the
provenance of every derived project copy.

## Decision

`DELETE /specs/:id` performs a **soft withdrawal (tombstone)** of a library
master, not a hard delete.

- Add `specs.withdrawn_at timestamptz NULL` (NULL = active). The row, its
  paragraphs, and `parent_spec_id` lineage edges stay intact. No change to
  `parent_spec_id` `onDelete`.
- Withdrawal targets **library masters** (`library_id` set). On a project copy
  (`project_id` set) `DELETE /specs/:id` returns **409**, directing callers to
  the existing `DELETE /projects/:id/specs/:specId` membership endpoint.
- `DELETE /specs/:id` → `200 { specId, withdrawnAt }`; `404` unknown; idempotent
  re-withdraw → `200` with the existing `withdrawnAt`.
- `POST /specs/:id/restore` clears `withdrawn_at` → `200` (reversible).
- **Read-path filtering:** withdrawn masters are hidden from listings and
  resolution — `GET /libraries/:id/specs` (`listLibrarySpecs`), project source
  resolution / broken-ref `availableFrom`, and the coordination "present" set all
  filter `withdrawn_at IS NULL`. `GET /specs/:id` still returns a withdrawn master
  with `withdrawnAt` surfaced, so lineage/history resolves.

## Consequences

- Custody/provenance is preserved and the action is reversible — aligned with
  ADR-015. Paragraph removal (the editability program) follows the same
  suppress-don't-destroy philosophy via `meta.vanish`.
- Cost: a `withdrawn_at` column plus a filter on every spec listing/resolution
  read path, and a `restore` path. The reads that must filter are enumerated
  above and re-confirmed in the implementation plan.
- No hard-delete escape hatch ships now; if a true purge is ever needed it is a
  separate, custody-reviewed decision.
