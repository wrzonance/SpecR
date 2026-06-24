# Spec — Phase 4 Remainder Disposition (Demo ↔ API Conformance)

**Status:** Approved (decisions confirmed 2026-06-23). Ready to plan.
**Refines:** `docs/superpowers/specs/2026-06-19-demo-backend-conformance.md` §9 (Phase 4 — Track B). That doc gated four design-ahead capabilities behind ADRs; this spec records the **resolved disposition** of each after Phase 1–3 and the coordination/required-sections work landed.

---

## 1. Problem

After the conformance program landed Phase 1–3 (#225/#231 demo conform, #227/#229 reads, #233/#235 writes, #236 flag flips) and the coordination track (#238/#239 required-sections substrate, #240 ADR-029, #241 coordination-report endpoint + MCP), the demo's `examples/web_ui_demo/js/features.js` has **four flags still `false`**:

```
projectSettings: false   // PATCH /projects/:id
specDelete:      false   // DELETE /specs/:id
paragraphDelete: false   // DELETE /specs/:id/paragraphs/:nodeId
coordination:    false   // coordination-report + required-sections
```

"Phase 4 remainder" is therefore **four independent items**, not one project. Each is scoped and dispositioned below. The mockup "island" backend (intact at `ae6a066^`) is a reference for *intent*, never the design.

## 2. Current state (verified 2026-06-23, against `origin/main`)

- **Coordination backend is fully landed.** `GET /projects/:id/coordination-report` (#241) returns `{ projectId, packageId, findings[], summary{ requiredNotPresent, presentNotRequired, danglingRef, total }, notes[] }`. Required-sections substrate (#239) serves `GET/PUT /projects/:id/required-sections` + package variants. The demo's `coordination.js` consumer reads exactly these fields; `api.js` `getJson` unwraps `.data`. **Shape matches end-to-end** — the only missing piece is the demo flag.
- **`section_number_format` rendering already exists** as a per-`generate` **output policy** (`GenerateBodySchema.sectionNumberFormat`, `lib/section-number.ts` renders `canonical|dots|compact`, grouped with style output policy in `ast/style-schemas.ts`). What's absent is any **persistence** of a default.
- **`PATCH /projects/:id` is absent.** Projects are top-level mutable entities; no custody constraint blocks renaming one.
- **`DELETE /specs/:id` is absent.** Ownership is XOR (`specs.library_id` master XOR `specs.project_id` copy, mig 016). Project membership is a **separate clone row** (`parent_spec_id` → master, mig 019). FKs: `project_specs.spec_id` `RESTRICT`, `specs.parent_spec_id` has no `onDelete` (NO ACTION) — so a master with any clone already cannot be hard-deleted.
- **Paragraph delete is absent.** The editability program (#135–#140) added classify / reclassify / accept-as-note / associations — **no `DELETE`**.

---

## 3. Item A — Coordination panel (flag-flip)

**Decision:** Flip `API_FEATURES.coordination = false → true`. No backend or ADR work (ADR-029 merged; #241 serves the endpoint).

**Rationale:** Response shape verified field-by-field against `coordination.js` (`summary.{total,presentNotRequired,requiredNotPresent,danglingRef}`, `findings[].{section,title,sourceSpecSection,targetSpecSection,referenceText}`, `notes[]`). The endpoint was built to the demo's contract.

**Scope:** `examples/web_ui_demo/js/features.js` (one line). Unlinted, cannot destabilize `main`.

**Acceptance:** Against a seeded DB — parse a spec into a project, author required-sections via `PUT /projects/:id/required-sections`, open the coordination panel; summary counters + three finding groups render; zero console errors / 404s.

## 4. Item B — Project settings & mutability (split)

The island's `PATCH /projects/:id` took `{ name, sectionNumberFormat }` with `section_number_format` a bare `projects` column (mig 032, CHECK `canonical|dots|compact`). We **split** this:

### B1 — Project rename (build now)
**Decision:** `PATCH /projects/:id` accepting **`{ name }` only**. Plain mutable column on a top-level entity; no custody concern, no heavy ADR.

**Scope:** `PatchProjectBodySchema = { name: string (≥1) }`; `updateProjectName(id, name, db?)`; `patchProjectHandler` (404 unknown); `openapi.yaml` path; integration test. Demo: remove the `#project-number-format` control from `saveProjectSettings` (so it sends only `{ name }`), flip `projectSettings = true`. `renameActiveProject` already sends `{ name }`.

### B2 — Persisted `section_number_format` (defer)
**Decision:** Do **not** add a bare `projects.section_number_format` column. Fold a *persisted default* into the scoped **style/output profile** (#125, ADR-021 JSONB style storage, resolution chain firm→client→project→package→revision), as its own ADR.

**Rationale:** The renderer already accepts the format per-generate (`GenerateBodySchema`), so persistence is YAGNI for the demo. When persisted, it belongs to the output-policy profile it already groups with — not a project column the roadmap explicitly warned against. The demo's format dropdown is really a generate-time choice.

## 5. Item C — Master spec delete → **soft-delete / withdraw** (ADR-030)

**Decision:** `DELETE /specs/:id` performs a **soft withdrawal (tombstone)** of a library master — not a hard row delete. This is the substantial item; it gets **ADR-030** before any code.

**Rationale:** ADR-015's thesis is *layered-spec-hierarchy chain-of-custody*. Hard-deleting a master destroys the provenance of every derived project copy (`parent_spec_id` lineage). A withdrawal preserves the chain, is reversible, and still satisfies the demo's need ("removes the library copy; project TOCs unchanged").

**Design (becomes ADR-030 body):**
- **Schema:** add `specs.withdrawn_at timestamptz NULL` (NULL = active). Migration reversible. The row, its paragraphs, and `parent_spec_id` edges all stay intact — *no* change to `parent_spec_id` `onDelete` (the opposite of the hard-delete option).
- **Target:** withdrawal applies to **library masters** (`library_id` set). On a **project copy** (`project_id` set), `DELETE /specs/:id` returns **409** pointing at the existing `DELETE /projects/:id/specs/:specId` membership path (don't overload it).
- **Endpoint:** `DELETE /specs/:id` → `200 { specId, withdrawnAt }`; `404` unknown; **idempotent** re-withdraw → `200` with the existing `withdrawnAt`. Reverse: `POST /specs/:id/restore` clears `withdrawn_at` → `200` (reversible; cheap to include in v1).
- **Read-path filtering (the real surface area):** hide withdrawn masters from *listings and resolution* — `GET /libraries/:id/specs` (`listLibrarySpecs`), project source resolution / broken-ref `availableFrom`, and coordination "present" sets all filter `withdrawn_at IS NULL`. `GET /specs/:id` still returns a withdrawn master **with `withdrawnAt` surfaced** so lineage/history resolves (only listings hide it).
- **Contract:** `openapi.yaml` documents `DELETE /specs/:id` (+ `restore`) and the new `withdrawnAt` field; contract gate stays green.

**Scope estimate:** migration + handler + `restore` + ~3 read-path filters + openapi + tests. Likely two PRs (ADR-030 first, then implementation), each ≤500 LOC.

**Demo:** flip `specDelete = true`; `removeSpecFromLibrary` and the post-leave "library purge" path both map cleanly to withdraw.

## 6. Item D — Paragraph delete (defer)

**Decision:** Keep `paragraphDelete = false`. Hard paragraph deletion (the demo's cascading node+subtree+refs removal) is **not** a demo-conformance one-off — it is an open **editability-program** question (ADR-022, #128–#147).

**Rationale:** #135–#140 delivered classification, not deletion. By symmetry with the C decision (soft over hard), paragraph removal is most consistent as `meta.vanish` (suppress render, keep the row) via the existing `PATCH .../paragraphs/:nodeId` — but that is the editability program's call, designed there, not rushed here. File an issue; no code in this phase.

---

## 7. Implementation sequencing

Each item is an independent PR, branched off `origin/main`, `openapi.yaml` + tests in the same PR, ≤500 LOC, Conventional Commits scoped to the module, credit the agent.

1. **A — coordination flag-flip** (`examples/` only). Flip + smoke test. Lowest risk.
2. **B1 — `PATCH /projects/:id { name }`** + examples follow-up (drop format control, flip `projectSettings`).
3. **C — ADR-030 (soft-delete/withdraw)** → merge → migration → withdraw handler + `restore` → read-path filters → openapi + tests → flip `specDelete`.
4. **Deferred housekeeping** — file two issues, no code:
   - B2: persist default `section_number_format` as a scoped output policy (fold into style profile #125).
   - D: paragraph removal lifecycle (vanish vs delete) under the editability program (ADR-022).

Sequencing rationale: A and B1 are quick demo-unblocking wins; C is the heavy ADR-gated build; B2/D are tracked and parked.

## 8. Done criteria

- **A:** `coordination` flag on; panel renders against a seeded project; no 404s.
- **B1:** project rename works from the demo; `projectSettings` on; contract gate green.
- **C:** ADR-030 merged; withdrawing a master hides it from library listings + resolution while `GET /specs/:id` and lineage still resolve it; `restore` reverses; `specDelete` on.
- **Deferred:** B2 and D issues filed with labels + on the board.

## 9. Self-review

- **Coverage:** all four `false` flags have a decision + a build/defer disposition; nothing silently dropped.
- **Consistency:** C (soft/withdraw) and D (defer toward `meta.vanish`) share one philosophy — *suppress, preserve custody, stay reversible* — rather than hard destruction. B splits the trivial gap (rename) from the contested one (format persistence).
- **Ambiguity resolved:** `DELETE /specs/:id` targets masters; project copies use the existing membership endpoint (409). Withdrawn masters are hidden from listings/resolution but still readable by id for lineage.
- **Open for the implementer:** confirm `projects.name` uniqueness (whether B1 needs a 409 path); confirm every read path that must filter `withdrawn_at` (listings, resolution, coordination "present"); decide whether `restore` ships in C's first implementation PR or a follow-up.
