# Spec — Required Sections Substrate (ADR-028)

**Status:** Design approved (brainstorming, 2026-06-22). Decision-of-record: `docs/adr/028-required-sections.md`.
**Scope:** the `required_sections` storage + authoring API only. The coordination **report** (#105) and the
Revit preflight (#84) are separate downstream work that consume this substrate.
**Phase:** 4 / Track B (first design gate of the demo↔backend conformance roadmap).

This spec is the *how*; ADR-028 is the *why and what*. Read the ADR first — this document does not
re-argue the decision, it lays out the implementation blueprint a plan can be written against.

---

## 1. Goal

Land a first-class, authored "required sections" list at project- and package-grain so that a project
can declare the CSI section numbers it must contain — **including sections not yet derived as documents** —
independent of `project_specs`/`package_specs`. This is the substrate that makes #105's
"required-but-missing" finding possible and gives #84 a write target.

## 2. Data model

New migration `031_create_required_sections.ts` (reversible up/down). FK targets all exist on `main`
(`projects` mig 006, `design_packages` mig 020).

```
required_sections
  id          uuid    primary key default gen_random_uuid()
  project_id  uuid    not null  references projects(id)        on delete cascade
  package_id  uuid    null      references design_packages(id) on delete cascade   -- NULL = project baseline
  section     text    not null
  title       text    null
  position    integer not null  check (position >= 1)
```

Constraints / indexes:

- `unique (project_id, section)             where package_id is null`   — one baseline row per section.
- `unique (project_id, package_id, section) where package_id is not null` — one row per section per package.
- `index (project_id, package_id)` — scope lookups for read + report.
- `check` on `section` matching the canonical CSI expanded shape. **Re-derive the pattern from
  `lib/section-number` / migration 013 — do not paste the island regex.** Confirm the exact form during
  implementation (`NN NN NN[.NN[ NN]]`).

`title` is an advisory label only — meaningful for not-yet-derived sections; once a section is derived its
authoritative title comes from the spec, not this row.

## 3. DB query layer (`src/db/queries/required-sections.ts`, barrelled in `src/db/index.ts`)

Parameterized only (no string-built SQL). All functions take an optional `db`/`pool` like the existing
query modules.

- `listRequiredSections(projectId, packageId | null, db?) : Promise<RequiredSection[]>`
  — rows for one scope, ordered by `position`. `RequiredSection = { id, section, title: string|null, position }`.
- `setRequiredSections(projectId, packageId | null, entries, db?) : Promise<RequiredSection[]>`
  — transactional **full replace** of one scope (DELETE scope rows → INSERT … WITH ORDINALITY for
  `position`), mirroring `setProjectSources`. Returns the new ordered rows.
- `seedRequiredSections(projectId, packageId, from, db?) : Promise<RequiredSection[]>`
  — atomic copy into a package scope from `from ∈ { baseline | toc | { packageId } }`:
  - `baseline` → copy `package_id IS NULL` rows (section, title, position).
  - `toc` → copy the project's `project_specs` sections (section + spec title), ordered by the TOC.
  - `{ packageId }` → copy another package's rows.
  Only valid when the target scope is empty (else 409 / explicit replace).
- Existence helpers reused: `findProjectById`, and a `findPackageById(projectId, packageId)` (add if absent;
  must scope the package to the project to avoid cross-project leakage).

Errors raised as typed `DatabaseError`/`InvalidSectionError` so the handler maps them; PG `23505` → 409,
`23514` (check) → 422.

## 4. API layer (`src/api/required-sections.ts`, routes in `src/api/router.ts`)

Handlers follow the house pattern (validate id with `z.uuid()` → 400; Zod body → 422; typed-error mapping;
no `any`; `ApiResponse<T>` envelope).

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /projects/:id/required-sections` | — | `200 ApiResponse<RequiredSection[]>` (baseline) | 400 bad id, 404 unknown project |
| `PUT /projects/:id/required-sections` | `{ sections: [{ section, title? }], seedFrom? }` | `200 ApiResponse<RequiredSection[]>` | 400, 404, 422 bad shape, 409 dup |
| `GET /projects/:id/packages/:packageId/required-sections` | — | `200 ApiResponse<RequiredSection[]>` (package) | 400, 404 unknown project/package |
| `PUT /projects/:id/packages/:packageId/required-sections` | `{ sections: [...], seedFrom? }` | `200 ApiResponse<RequiredSection[]>` | 400, 404, 422, 409 |

- `seedFrom: 'baseline' | 'toc' | { packageId: uuid }` is honored **only when the target scope is empty**
  and `sections` is omitted/empty; otherwise the explicit `sections` body is the replace payload. (One PUT,
  two mutually-exclusive modes: explicit-replace vs seed. Reject "both supplied" with 422.)
- `section` validated with the existing `section-number` Zod schema; duplicates within a payload → 422
  *before* hitting the DB (clear message), matching `SetProjectSourcesBody`'s duplicate guard.

### OpenAPI (ADR-026 — same PR)

Add the four paths + a `RequiredSection` schema + the `RequiredSectionsBody` request schema to
`openapi.yaml`. The contract gate (`src/api/contract.integration.test.ts`) must stay green
(route↔spec bidirectional + response-schema validation).

## 5. Demo wiring (follows, not part of the substrate PR)

The demo already has `getRequiredSections` / `setRequiredSections` stubs gated behind
`API_FEATURES.coordination` (still `false`). Flipping that flag belongs with **#105** (the report is what
the coordination panel renders), not this substrate PR — flagging it on here would advertise a panel that
has nothing to show. Leave `coordination: false`.

## 6. Test plan (integration-first, real Postgres)

- DB: insert baseline rows → `listRequiredSections(project, null)` returns them ordered; package scope is
  isolated from baseline; `unique` partial indexes reject dup section per scope; `check` rejects a malformed
  section; `position` renumbers on replace.
- Seed: `seedRequiredSections(pkg, 'baseline')` copies baseline rows as an independent snapshot — mutating
  the baseline afterward does **not** change the package (the D2 invariant, pinned as a named regression test).
  `'toc'` copies `project_specs`; `{ packageId }` copies a sibling package.
- API: each endpoint asserts status + `ApiResponse` envelope + a representative row; error paths
  (400/404/422/409) each pinned; `seedFrom` + `sections` both supplied → 422.
- Contract gate green.

## 7. Sequencing / chunking

One PR, ≤~250 LOC of real change (excl. `openapi.yaml`): migration 031 → query module → handlers + routes
→ `openapi.yaml` → tests, each step keeping the build green. Branch `feat/api-required-sections` off
`origin/main`. Conventional Commits scoped per module (`feat(db): …`, `feat(api): …`). Links the new
substrate issue; references ADR-028.

## 8. Out of scope (explicit)

- The coordination **report** and its finding classes (#105) — next ADR, depends on this.
- Revit-driven population (#84) — a downstream writer.
- Drift visibility between a package and its baseline seed (future; ADR-015 D2 has the pattern).
- A `not_applicable`/`waived` status (removal covers de-requirement) and any history/audit of dropped sections.
- Firm/client scoped-profile tiers (don't exist yet).
- Demo `coordination` flag flip (rides with #105).

## 9. Open items for the implementer

1. Confirm the exact `section` CHECK pattern from `lib/section-number` / migration 013 before writing the
   migration (don't assume the island regex).
2. Confirm `findPackageById` exists in `src/db/queries/packages.ts`; if not, add a project-scoped variant.
3. Decide the precise `RequiredSectionsBody` Zod shape for the dual replace/seed modes (one schema with a
   refine rejecting "both `sections` and `seedFrom`", vs a discriminated union) — pick one, document it.
