# Spec — Demo ↔ API Conformance & Roadmap-First Backend Gaps

**Status:** Approved sequence, ready to plan per phase.
**Supersedes the sequencing in:** `docs/superpowers/plans/2026-06-18-demo-backend-roadmap.md` (that doc's triage matrix is the originating analysis; this spec is the canonical design).
**Owner decisions still open:** see §8.

---

## 1. Problem

`examples/web_ui_demo` (merged to `main` via #225, frontend-only by design) was built against the **mockup island API** — ~14 endpoints that were never on `main`. On a fresh `main` DB the demo's boot panels call `GET /libraries` and `GET /projects`, get 404, and the board cannot populate. The island backend (intact at `ae6a066^`) is a **reference for "here's a gap," not a spec**: SpecR's API shape is governed by its ADRs and roadmap, and the demo must conform to that — not the reverse.

## 2. Goals / Non-goals

**Goals**
- Make the demo *load cleanly and conform* to `main`'s current API immediately, with honest "unavailable" states where main lacks an endpoint (Phase 1).
- Then land the **genuine, ADR-aligned gaps** the demo demonstrates, smallest/cleanest first, each with `openapi.yaml` + tests (Phases 2–3).
- Gate the design-ahead-of-roadmap capabilities behind ADRs before any code (Phase 4).

**Non-goals**
- Restoring the island backend wholesale. We do **not** copy its migrations (`031_create_required_sections`, `032_project_settings`) or handler shapes without an ADR.
- Adding a global `GET /specs` index (conflicts with the scoped-ownership design — specs are library- or project-owned). The demo lists specs *scoped*.
- Pagination (deferred per ADR-026; MVP list endpoints return the full `data: T[]`).

## 3. Guiding principles

- **Backend dictates the contract; the demo conforms.** `openapi.yaml` is authoritative and CI-enforced (ADR-026): every new route is documented in the same PR.
- **Roadmap/ADR-first.** A capability lands only when it matches an ADR/issue, designed from that — using the island only as an input.
- **`examples/` is unlinted and isolated.** Phase 1 touches only `examples/`; it cannot destabilize `main`.
- **Chunking:** each backend slice ≤ ~250 LOC, one demonstrable change, branch `feat/…` off `origin/main`, never commit to main.

## 4. Confirmed sequence

1. **Phase 1 — C-thin:** conform the demo to main's surface (guard + 2 repoints) via a single capability-flag map.
2. **Phase 2 — PR-1 + PR-2:** land the cleanest read gaps (`GET /libraries`, `GET /libraries/:id/specs`, `GET /projects`); flip their flags on in the demo.
3. **Phase 3 — Track A writes:** `PATCH /libraries/:id`, `POST /libraries/clients`, `PUT /projects/:id/sources`; flip flags.
4. **Phase 4 — Track B (ADR-gated):** required-sections, coordination-report (#105), project settings/mutability, master hard-delete. ADR before code.

---

## 5. Phase 1 — C-thin (demo conformance)

**Branch:** `fix/demo-conform` · **Scope:** `examples/web_ui_demo/**` only.

### 5.1 Design — one capability map, gated panels, two repoints

Introduce a single source of truth for "what this API build supports." Panels read it; as Phase 2/3 endpoints land, the demo flips a flag instead of being rewritten.

- **New file `examples/web_ui_demo/js/features.js`:**
  ```js
  // Which optional API capabilities the connected SpecR build serves.
  // Flip a flag to true when its endpoint lands on main (see the backend spec).
  export const API_FEATURES = {
    listSpecsGlobal: false,     // GET /specs (intentionally never added — use scoped listing)
    libraries: false,           // GET /libraries, GET /libraries/:id/specs        (Phase 2)
    libraryWrites: false,       // POST /libraries/clients, PATCH /libraries/:id   (Phase 3)
    projectsList: false,        // GET /projects                                   (Phase 2)
    projectSettings: false,     // PATCH /projects/:id                             (Phase 4)
    projectSources: false,      // PUT /projects/:id/sources                       (Phase 3)
    specDelete: false,          // DELETE /specs/:id                               (Phase 4)
    paragraphDelete: false,     // DELETE /specs/:id/paragraphs/:nodeId            (Phase 4 / editability)
    coordination: false,        // coordination-report + required-sections         (Phase 4)
  };
  ```

### 5.2 Per-function decisions (every api.js endpoint)

| api.js fn | Endpoint | Action | Detail |
|---|---|---|---|
| `checkHealth`, `uploadSpec`, `getParseJob`, `waitForParseJob`, `updateParagraph`, `createProject`, `getProject`, `addSpecToProject`, `removeSpecFromProject`, `getBrokenRefs` | (present on main) | **keep** | Core parse→board→view→refs path. |
| `getSpecTree(id)` | `GET /specs/:id/tree` → **`GET /specs/:id`** | **repoint** | Use the existing single-spec endpoint, which already returns the tree (`getSpecHandler` merges `styleSource`). Adjust callers (app.js:489, 1690) to read the tree off the returned object; confirm shape (`data.tree` vs `data`). |
| `deleteReference(specId, refId)` | `DELETE /specs/:id/references/:refId` | **repoint** | References are derived from paragraph text. The edit-commit flow (`commitTextEdit`) already PATCHes the paragraph; drop the explicit `deleteReference` call and let the server re-derive refs from the edited text. Guard under `!API_FEATURES.refDelete` is unnecessary once removed. |
| `listSpecs` | `GET /specs` | **guard** | `listSpecsGlobal=false` permanently. The board seeds via upload + project/library scope, never a global list. |
| `listLibraries`, `listLibrarySpecs` | `GET /libraries`, `GET /libraries/:id/specs` | **guard** | `libraries` flag. Library Manager renders a placeholder; no fetch. |
| `createClientLibrary`, `renameLibrary` | `POST /libraries/clients`, `PATCH /libraries/:id` | **guard** | `libraryWrites` flag. Hide/disable create+rename controls. |
| `listProjects` | `GET /projects` | **guard** | `projectsList` flag. Project switcher shows placeholder. |
| `patchProject` | `PATCH /projects/:id` | **guard** | `projectSettings` flag. Settings controls disabled. |
| `setProjectSources` | `PUT /projects/:id/sources` | **guard** | `projectSources` flag. Source-editing disabled. |
| `deleteSpec` | `DELETE /specs/:id` | **guard** | `specDelete` flag. Hide the spec-delete action. |
| `deleteParagraph` | `DELETE /specs/:id/paragraphs/:nodeId` | **guard** | `paragraphDelete` flag. Hide paragraph-delete; editing (PATCH) stays. |
| `getCoordinationReport`, `getRequiredSections`, `setRequiredSections` | coordination/required-sections | **guard** | `coordination` flag. Coordination panel renders "not available in this build". |

### 5.3 Behavior target & acceptance criteria

- Demo boots with **zero uncaught errors and zero 404 XHRs** for gated features (gated panels never fetch).
- **Working end-to-end:** drop a `.SEC`/DOCX → parse → spec renders on the board → open the sheet → cross-references/popovers resolve within loaded specs.
- Every gated panel shows a **clear, consistent placeholder** ("Not available in this API build — see roadmap"), not a broken/empty control.
- Verified by: `node --check` on every edited JS file; a manual smoke run of `./Start-SpecR.sh` (now port-safe) confirming the above against `main`.

### 5.4 Files

- Create: `examples/web_ui_demo/js/features.js`
- Modify: `examples/web_ui_demo/js/api.js` (repoint `getSpecTree`; remove `deleteReference` usage path), `js/app.js` (gate `initLibraryManager`, `initProjectManager`, TOC sources/settings, coordination panel, spec/paragraph-delete actions on `API_FEATURES`), and any panel module that renders the gated controls (`coordination.js`, `tree.js` edit affordances).

---

## 6. Phase 2 — PR-1 & PR-2 (read gaps, ADR-015-aligned)

Each endpoint: Express route + handler + `openapi.yaml` path & response schema + integration test, then flip the demo flag in a follow-up `examples/` commit.

### PR-1 — Library read API (`feat/api-library-read`)
- **`GET /libraries`** → `ApiResponse<Library[]>`, ordered `tier, name`. Reuse `listLibraries()` (on main per #92). `Library = { id, tier: 'reference'|'company'|'client', name, owner: string|null, parentLibraryId: string|null, createdAt }`.
- **`GET /libraries/:id/specs`** → `ApiResponse<LibrarySpec[]>`; `404` if library unknown. `LibrarySpec = { specId, section, title: string|null, nodeCount: number }`. Add `listLibrarySpecs(libraryId, db?)` to `src/db/queries/libraries.ts` — re-derived against current `specs`/`paragraphs` schema (reference, do not paste, `ae6a066^:src/db/queries/libraries.ts`); parameterized; `nodeCount` cast to int.
- Demo flip: `API_FEATURES.libraries = true`; repoint the demo's spec-listing to `GET /libraries/:id/specs` + project TOC (retires the `listSpecsGlobal` gap entirely).

### PR-2 — Projects list (`feat/api-projects-list`)
- **`GET /projects`** → `ApiResponse<ProjectListItem[]>`. Reuse `listProjects()` (on main per #162; confirm exact return type — it backs the MCP `list_projects` tool).
- **Pre-step:** cross-check `openapi.yaml` for an existing `/projects` `get:`. If documented-but-unrouted, this PR also fixes a latent contract-gate gap — note it.
- Demo flip: `API_FEATURES.projectsList = true`.

**Issues to file first** (both are untracked gaps): "feat(api): library read API (GET /libraries, GET /libraries/:id/specs)" and "feat(api): GET /projects list". Apply type+area+priority labels; add to the Project board.

---

## 7. Phase 3 — Track A writes

### PR-3 — Library management (`feat/api-library-write`)
- **`PATCH /libraries/:id`** (rename) — body `{ name }` (Zod, ≥1 char). **Decision (default, see §8):** rename `name` only; leave `owner` immutable (island also rewrote `owner` for client tier — do not, unless §8 says so). `404` unknown; `409` on unique-name (`23505`). Add `updateLibraryName(id, name, db?)`.
- **`POST /libraries/clients`** — body `{ name, parentLibraryId? }`. **Decision (default):** parent = explicit `parentLibraryId` if given, else `resolveDefaultLibraryId()` (on main per #92) — **not** a literal name lookup of "Default Company Master" (island idiosyncrasy). `201` with `Library`; `409` dup.
- Demo flip: `API_FEATURES.libraryWrites = true`.

### PR-4 — Project sources update (`feat/api-project-sources`)
- **`PUT /projects/:id/sources`** — body `{ sourceLibraryIds: string[] }` (Zod). Transactional full replace of the project's ordered source list. **Decision (default):** re-ordering sources does **not** re-resolve already-derived specs (copies are immutable per ADR-015 D2); sources affect only future resolution + the broken-ref `availableFrom` advisory. `404` unknown project; `422` if any library id is invalid. Add `setProjectSources(projectId, ids, db?)`.
- Demo flip: `API_FEATURES.projectSources = true`.

---

## 8. Owner decisions (confirm before Phase 3)

1. **Client-library rename & `owner`:** default = rename `name` only, `owner` immutable. (Island synced `owner=name` for client tier.) — confirm.
2. **Client-library parent:** default = explicit `parentLibraryId` else `resolveDefaultLibraryId()`. — confirm.
3. **Project sources re-resolution:** default = no re-resolution of existing copies; future-only. — confirm.
4. **Global `GET /specs`:** default = never add; demo lists scoped. — confirm (already leaning this way).

(Defaults are chosen to match ADR-015; speak up only to override.)

---

## 9. Phase 4 — Track B (ADR gates, no code until merged)

Each is an ADR PR (`docs/adr/NNN-*.md`: Status/Context/Decision/Consequences), then a per-capability implementation plan. The island at `ae6a066^` is an input, not the design.

1. **ADR — required-sections.** First-class authored table vs derived from division-general (ADR-023) + design-package membership (ADR-015 D4)? File the missing issue. Unblocks #105.
2. **ADR/promote — coordination-report (#105).** Vet out of Backlog; specify finding-classes + response contract independently (island's present-not-required / required-not-present / dangling-ref are a reference). Depends on #1.
3. **ADR — project settings & mutability.** Does `PATCH /projects/:id` exist; is `section_number_format` a column (island mig 032) or part of a scoped settings profile?
4. **ADR — master spec hard-delete custody.** Define `DELETE /specs/:id` behavior w.r.t. derived copies / lineage before exposing it.

Demo: `coordination`, `projectSettings`, `specDelete`, `paragraphDelete` flags flip as these land.

---

## 10. Cross-cutting

- **OpenAPI contract gate (`src/api/contract.integration.test.ts`)** must stay green: route↔spec bidirectional coverage + response-schema validation. Every backend PR updates `openapi.yaml`.
- **Testing:** integration tests against real Postgres (`pnpm migrate → seed → test → test:integration`). Pin each endpoint with an integration test asserting status + envelope + a representative row.
- **Module boundaries:** handlers import DB fns only from `../db/index.js`; add new query fns to the barrel.
- **Error mapping:** typed errors → middleware (`ParserError`→422, conflict→409, unknown→500); Zod-validate bodies; map PG `23505`→409, `23514`→422, missing→404.
- **Demo flag flips** ride in the *same PR* as (or an immediate follow-up to) the endpoint that backs them, so `main` never advertises a capability the API can't serve.

## 11. Done criteria

- **Phase 1:** demo boots clean against `main`, parse→view works, gated panels show placeholders; merged to main (examples-only).
- **Phase 2:** Library + Project panels populate from real endpoints; contract gate green.
- **Phase 3:** create/rename client library + edit project sources work from the demo.
- **Phase 4:** each ADR merged; its capability implemented per ADR and its demo flag flipped.
