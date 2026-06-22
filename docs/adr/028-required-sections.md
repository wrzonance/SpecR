# ADR-028: Required Sections — Authored Coordination Intent

## Status

Proposed (Phase 4 — Track B design gate). Substrate for #105 (coordination report) and #84 (Revit-driven required-sections registry). No endpoint code lands until this ADR merges.

## Context

A project's structure is recorded today by two tables that both point at **derived spec
documents**:

- `project_specs` — the project's full table of contents (FK → the project's own `specs` copies).
- `package_specs` (ADR-015 D4) — issuable subsets of that TOC.

Both can only name a section that **already exists as a document**. But the single most
important coordination signal is the opposite case: *a section the project is contractually
required to contain that nobody has authored yet.* A list keyed on document FKs structurally
cannot express it.

ADR-023 already resolved this same tension one grain down. Division-general inheritance does
**not** silently infer a `NN 00 00`; when the exact section is absent it surfaces
`status: missing` with advisory candidates, and a human decision is explicit. The house rule
is *visible-not-hidden: name the gap, never infer it away.* "Required sections" is that rule
at project/package grain — an authored list of section **numbers** a corpus must contain,
held independently of what has been derived.

The demand is concrete and already on the roadmap: #105 (project coordination report) needs a
"required" set to diff against the present set, and #84 (Revit family-category → required
MasterFormat preflight) needs a place to write the sections a BIM model implies. The deleted
mockup island carried a `required_sections` table and a 383-LOC report CTE; per ADR/roadmap-first,
the island is an **input to this design, not the design**.

There is no first-class tracking issue for the substrate itself (only #105/#84, which consume
it) — one is filed alongside this ADR.

## Decision

Add a first-class `required_sections` table that stores authored coordination intent —
the CSI section numbers a project (and each design package) must contain — **independent of
`project_specs`/`package_specs`**. Storing numbers, not document FKs, is what makes
"required-but-never-authored" representable.

```
required_sections                                  -- migration 031
  id          uuid    primary key default gen_random_uuid()
  project_id  uuid    not null  references projects(id)         on delete cascade
  package_id  uuid    null      references design_packages(id)  on delete cascade  -- NULL = project baseline
  section     text    not null  -- canonical CSI expanded shape (ADR-020); CHECK re-grounded on lib/section-number
  title       text    null      -- advisory human label for not-yet-derived sections
  position    integer not null  check (position >= 1)
  unique (project_id, section)             where package_id is null
  unique (project_id, package_id, section) where package_id is not null
  index (project_id, package_id)
```

The shape is re-derived from the island migration; the `section` CHECK is re-grounded on the
current `lib/section-number` grammar and migration 013's pattern, **not pasted**.

### Scope grain

- `package_id IS NULL` → the **project baseline** required list.
- `package_id = X` → that **package's** required list.

### Semantics

- **Baseline** is authored and may name sections with no derived spec yet. It can be seeded in
  one shot from the current `project_specs` TOC as a convenience, after which the TOC and the
  baseline are **independent** — editing one never mutates the other.
- **Package list** is an **independent** list, **seeded by copy** at creation from the baseline
  (default) or from another package, then edited up/down freely. The copy is a **snapshot**:
  later edits to the baseline or the source package do **not** propagate (consistent with
  ADR-015 D2, copy-without-silent-propagation). This makes packages templatable from a project
  master or a prior package.
- **Independence from the TOC is intentional.** A section may be required-but-absent,
  present-but-not-required, or both — these are exactly the coordination-report finding classes.
- **Removal is de-requirement.** Dropping a section from a list *is* how an editor says "not
  required here," so **no `not_applicable` status** is introduced (unlike ADR-023, where fallback
  inference forced one — there is no inference here to override).

### Validation & error mapping

- `section` is validated against the canonical CSI expanded grammar (ADR-020, `lib/section-number`)
  at the Zod boundary and by a DB CHECK mirroring migration 013.
- **422** invalid section shape; **404** unknown project/package; **409** duplicate section within a
  scope (`23505`); transactional full-replace per scope (same pattern as `setProjectSources`).

### API surface

- `GET` / `PUT /projects/:id/required-sections` — read / transactional-replace the baseline.
  Body: `{ sections: [{ section, title? }], seedFrom? }`; `position` = array order (the PUT-replace
  shape used by `/projects/:id/sources`, extended with an optional seed).
- `GET` / `PUT /projects/:id/packages/:packageId/required-sections` — read / replace a package list.
- **Seeding:** `PUT` accepts an optional `seedFrom: 'baseline' | 'toc' | { packageId }` when the
  target list is empty; the server copies atomically.
- Every route is documented in `openapi.yaml` in the same PR (ADR-026 contract gate).

## Consequences

- **#105 is unblocked:** the coordination report diffs a scope's required set (baseline or package
  rows) against its present set (`project_specs`/`package_specs`) plus dangling references, yielding
  the three finding classes. That report is its **own** ADR/issue; this one lands only the substrate.
- **#84 has a write target:** the Revit preflight materializes its derived required sections here.
- **No retro-mutation of issued work:** because package lists are snapshots, editing a baseline never
  silently changes a package that was already seeded (matches D2). **Drift visibility** between a
  package and its seed is a deliberate future enhancement, not built now.
- **Lean status model:** no `not_applicable`/`waived` column. If an audit trail of *why* a section was
  dropped is later needed, revisit — removal alone does not record intent history.
- **Bounded surface:** one table + ~4 endpoints + `openapi.yaml`. Fits one ≤~250-LOC implementation PR.

## Alternatives considered

- **Derived view** (`required` = whatever is in `project_specs`/packages): rejected — cannot represent
  intent that outruns reality, which is the entire purpose (required-but-missing).
- **Scoped-profile chain** (firm→client→project→package, like conventions/H-F/style): rejected for now —
  firm/client library tiers do not exist yet; this would pull large unbuilt scaffolding into scope.
- **Baseline mirrors the TOC live:** rejected — blurs intent vs reality and contradicts the
  independent-authored model.
- **Package list as subset-assignment of the baseline, or baseline ∪ additions:** rejected in favor of
  independent-seeded-by-copy — the richest model, lets a package diverge freely and be templated from a
  prior package or the project master, with no cross-list coupling.

## Related

- ADR-015 (D2 copy-without-propagation, D3 `project_sources`, D4 `design_packages`/`package_specs`),
  ADR-020 (section-number expanded shape), ADR-023 (division-general visible-not-hidden),
  ADR-026 (OpenAPI contract gate).
- Issues: #237 (this substrate — tracking), #105 (coordination report — consumer),
  #84 (Revit required-sections registry — writer).
