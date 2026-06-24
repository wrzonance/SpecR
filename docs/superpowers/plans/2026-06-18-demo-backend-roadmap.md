# Demo Backend — Roadmap-First Landing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the *Track A* tasks task-by-task. Track B items are **design gates** (write an ADR / vet against the roadmap) before any TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the `examples/web_ui_demo` board functional on `main` by landing only the API endpoints that align with SpecR's roadmap/ADRs — adjusting the demo to use existing/proper endpoints everywhere the mockup island invented a shape that fights the architecture.

**Architecture:** The mockup island is a *source of "here's a gap to consider," not a spec.* Every demo-required endpoint is triaged into **Track A — land now** (genuine gap, ADR-aligned, DB layer largely exists), **Track B — design first** (capability wanted but ahead of roadmap; needs an ADR and lives behind issue #105 et al.), or **Track C — adjust the demo** (island shape contradicts the design; repoint the demo at existing endpoints). The backend dictates the contract; the demo conforms.

**Tech Stack:** TypeScript/Node 22, Express, Zod, node-pg-migrate, PostgreSQL, hand-authored `openapi.yaml` (CI-enforced contract gate), Vitest (unit + integration).

## Global Constraints

- **`openapi.yaml` is authoritative and CI-enforced** (ADR-026). Every new route MUST be added to `openapi.yaml` in the same PR (bidirectional route↔spec coverage + response-schema validation), or CI goes red three ways. Code conforms to the spec.
- **Module-boundary error classes** (`src/lib/errors.ts`): handlers throw typed errors; the API error middleware maps `ParserError`→422, `MergeError`→409, unknown→500. Chain `cause`. Validate external input with Zod.
- **ESLint enforced, not advisory:** `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, `no-console` error, `no-explicit-any` error. `src/` only — `examples/` is unlinted.
- **Module imports only via sibling `index.ts` barrels** (`../db/index.js`, never `../db/queries/foo.js`).
- **PRs ≤ ~500 LOC** of real change, one demonstrable change each. Branch `feat/…` from `origin/main`; never commit to main. Conventional Commits scoped to the module. Credit the agent that did the work.
- **Integration tests need real Postgres** (`pnpm migrate → seed → test → test:integration`). Pin each new endpoint with a regression/integration test.
- **ADRs required** for non-obvious decisions (Track B items each get one).
- **The mockup island (`ae6a066^`) is a reference, never ground truth.** Do not copy its migrations (`031_create_required_sections`, `032_project_settings`) or its handler shapes without an ADR blessing them.

---

## Triage Matrix — every demo-required endpoint

Source of demand: `examples/web_ui_demo/js/api.js`. "Island" = the implementation deleted by `ae6a066`, intact at `ae6a066^`.

| # | Demo call | Verdict | Roadmap basis |
|---|---|---|---|
| 1 | `GET /libraries` (list) | **A — land** | ADR-015 D1 (libraries first-class). `listLibraries()` DB fn already on main. No tracking issue → **file one.** |
| 2 | `GET /libraries/:id/specs` | **A — land** | ADR-015. Island `listLibrarySpecs` is a trivial `specs⋈paragraphs` aggregate. |
| 3 | `PATCH /libraries/:id` (rename) | **A — land** | ADR-015. Verify client-tier `owner` sync is desired before copying island behavior. |
| 4 | `POST /libraries/clients` | **A — land (redesign parent)** | ADR-015 tier model. Island resolves parent via name lookup of "Default Company Master" — replace with `resolveDefaultLibraryId()` / explicit parent. |
| 5 | `GET /projects` (list) | **A — land** | Projects are top-level entities; `listProjects()` DB fn exists. Browser shows live `404`. **Cross-check `openapi.yaml` doesn't already document it** (contract drift). No issue → **file one.** |
| 6 | `PUT /projects/:id/sources` | **A — land** | ADR-015 D3 multi-source resolution; updating sources post-creation is the natural complement to `POST /projects`'s `sourceLibraryIds`. |
| 7 | `GET /projects/:id/coordination-report` | **B — design first** | Issue **#105** (Backlog, Phase 4, "planned not built"). Island built a 383-LOC CTE — do **not** copy. Drive #105 through its own ADR. Depends on #8. |
| 8 | `GET`/`PUT /projects/:id/required-sections` (+ package variants) | **B — design first** | No first-class issue; only implied by #105 and the Revit-driven #84. Island's `required_sections` table (mig 031) is mockup-shaped. **File issue + ADR** deciding whether required-sections is first-class vs derived from division-general/packages. |
| 9 | `PATCH /projects/:id` (+ `section_number_format`) | **B — design first** | Project mutability + a settings field (island mig 032). Fold into the scoped-profile pattern (firm→client→project→package→revision) rather than a bare column. ADR needed. |
| 10 | `DELETE /specs/:id` (hard delete master) | **B — design first** | Custody/lineage implications (deleting a library master with derived project copies). ADR-015 custody must define the policy; island's "409 if pinned" is a start, not the policy. |
| 11 | `GET /specs/:id/tree` | **C — adjust demo** | `GET /specs/:id` already returns the full tree (`getSpecHandler` → `getSpecTree` + `styleSource`). The bare `/tree` route is redundant. Repoint `api.js`. |
| 12 | `GET /specs` (list all) | **C — adjust demo** | ARCHITECTURE/ADR: specs are library- or project-owned, **not globally listed**. Demo should populate via `GET /libraries/:id/specs` (#2) and project TOC, not a flat global index. |
| 13 | `DELETE /specs/:id/references/:refId` | **C — adjust demo** | References are **derived from paragraph text** at parse time. Deleting a ref row contradicts the model. Demo removes a reference by editing the paragraph (PATCH), which re-derives refs. |
| 14 | `DELETE /specs/:id/paragraphs/:nodeId` | **C — adjust demo (defer)** | Paragraph deletion belongs to the editability program (ADR-022, #128–#147), not a one-off. Demo uses existing edit ops / `meta.vanish` until that lands. |

**Already on main (no action):** `GET /specs/:id`, `/specs/:id/lineage`, `PATCH /specs/:id/paragraphs/:nodeId`, `POST /parse`, `GET /parse/jobs/:jobId`, `POST /projects`, `GET /projects/:id`, `POST`+`DELETE /projects/:id/specs[/:specId]`, `GET /projects/:id/references/{broken,inbound}`, `GET /projects/:id/specs/:specId/references`.

---

## Sequencing (chunked PRs)

Each Track A PR is independently shippable, ≤~250 LOC, with `openapi.yaml` + integration tests. Order is by demo-unblocking value and dependency.

1. **PR-1 — Library read API** (`GET /libraries`, `GET /libraries/:id/specs`). Unblocks the demo's library panel + per-library spec listing (which also replaces the demo's global `GET /specs`, #12). File issue first.
2. **PR-2 — Projects list** (`GET /projects`). Tiny; unblocks the board's project switcher. File issue first.
3. **PR-3 — Library management writes** (`PATCH /libraries/:id`, `POST /libraries/clients`). Depends on PR-1's barrel exports.
4. **PR-4 — Project sources update** (`PUT /projects/:id/sources`).
5. **Demo-adjust PR** — repoint `examples/web_ui_demo/js/api.js`: `getSpecTree`→`GET /specs/:id` (#11), spec listing→library/project scoped (#12), ref removal→paragraph edit (#13), drop paragraph-delete (#14); make the coordination panel degrade gracefully on 404 until Track B lands. (Touches only `examples/` — unlinted, separate from the API PRs.)
6. **Track B design gates** (each = an ADR PR, then implementation plan): ADR for required-sections (#8) → ADR/promote #105 coordination-report (#7) → ADR for project-settings/mutability (#9) → ADR for master hard-delete custody (#10). No code until the ADR is merged.

Dependency note: the demo's board *core* (list projects, list libraries, list specs-in-library, single-spec tree) is fully unblocked by PR-1 + PR-2 + the demo-adjust PR. Coordination/required-sections (Track B) only power the demo's coordination panel, which degrades to empty until designed.

---

## Track A — Implementable now

### Task 1: `GET /libraries` (list all libraries)

**Files:**
- Modify: `src/api/router.ts` (register route)
- Modify: `src/api/libraries.ts` (add `listLibrariesHandler`) — *create if absent on main; confirm with `ls src/api/libraries.ts`*
- Modify: `src/api/index.ts` (barrel export if handlers are surfaced there)
- Reuse: `listLibraries()` from `src/db/index.js` (already exported on main per ADR-015 #92)
- Modify: `openapi.yaml` (document `GET /libraries`)
- Test: `src/api/libraries.integration.test.ts`

**Interfaces:**
- Consumes: `listLibraries(db?): Promise<Library[]>` where `Library = { id: string; tier: 'reference'|'company'|'client'; name: string; owner: string | null; parentLibraryId: string | null; createdAt: string }`.
- Produces: `listLibrariesHandler(req, res): Promise<void>` returning `ApiResponse<Library[]>`.

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/api/libraries.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from './test-app.js'; // follow the existing integration-test app harness

describe('GET /libraries', () => {
  it('returns the seeded built-in libraries in tier,name order', async () => {
    const res = await request(app).get('/libraries');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    // built-in reference + company libraries are seeded (ADR-015 D1)
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const first = res.body.data[0];
    expect(first).toMatchObject({ id: expect.any(String), tier: expect.any(String), name: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run it; verify it fails** — `pnpm test:integration -- libraries` → FAIL (404 / route not found). *Confirm the harness import path against an existing `*.integration.test.ts` first.*

- [ ] **Step 3: Add the handler**

```typescript
// src/api/libraries.ts
import type { Request, Response } from 'express';
import { listLibraries } from '../db/index.js';

export async function listLibrariesHandler(_req: Request, res: Response): Promise<void> {
  const libraries = await listLibraries();
  res.status(200).json({ success: true, data: libraries });
}
```

- [ ] **Step 4: Register the route** in `src/api/router.ts` (place beside the other `/libraries/...` routes):

```typescript
import { listLibrariesHandler } from './libraries.js';
// ...
router.get('/libraries', listLibrariesHandler);
```

- [ ] **Step 5: Document in `openapi.yaml`** — add a `/libraries` path with `get:` → `200` `ApiResponse` whose `data` is an array of a new `Library` schema (`id`, `tier` enum, `name`, `owner` nullable, `parentLibraryId` nullable, `createdAt`). Match the contract-gate's response schema exactly.

- [ ] **Step 6: Run tests** — `pnpm test:integration -- libraries` → PASS; `pnpm lint` → clean (incl. the contract gate `src/api/contract.integration.test.ts`).

- [ ] **Step 7: Commit** — `git commit -m "feat(api): GET /libraries list endpoint (#<issue>)"`

### Task 2: `GET /libraries/:id/specs` (specs in a library, with node counts)

**Files:**
- Modify: `src/db/queries/libraries.ts` (add `listLibrarySpecs`), `src/db/index.ts` (barrel export)
- Modify: `src/api/libraries.ts` (add `listLibrarySpecsHandler`), `src/api/router.ts`
- Modify: `openapi.yaml`
- Test: `src/db/queries/libraries.integration.test.ts`, `src/api/libraries.integration.test.ts`

**Interfaces:**
- Produces: `listLibrarySpecs(libraryId: string, db?): Promise<LibrarySpec[]>` where `LibrarySpec = { specId: string; section: string; title: string | null; nodeCount: number }`; `listLibrarySpecsHandler(req, res)` → `ApiResponse<LibrarySpec[]>`, **404** if the library doesn't exist.

- [ ] **Step 1: Write the failing DB-query test** (insert a library + a spec with N paragraphs via the test factory; assert `listLibrarySpecs` returns one row with `nodeCount === N`). Reference the island query as a starting point: `git show ae6a066^:src/db/queries/libraries.ts` (the `listLibrarySpecs` fn — a `specs LEFT JOIN paragraphs … GROUP BY` ordered by `section`). **Re-derive it against main's current `specs`/`paragraphs` schema; do not paste blindly.**
- [ ] **Step 2: Run it; verify it fails.**
- [ ] **Step 3: Implement `listLibrarySpecs`** parameterized (no string-built SQL), returning `nodeCount` as an integer (cast `count(*)`), filtered by `library_id`.
- [ ] **Step 4: Add `listLibrarySpecsHandler`** — `404` when the library id is unknown (check existence or empty-vs-missing distinction via `findLibraryById`).
- [ ] **Step 5: Register route, document in `openapi.yaml`** (`/libraries/{id}/specs`, `200` array of `LibrarySpec`, `404`).
- [ ] **Step 6: Run unit + integration + lint → all pass.**
- [ ] **Step 7: Commit.**

> PR-1 = Task 1 + Task 2. Open a draft, drive CI + CodeRabbit green, link the new "library read API" issue.

### Task 3: `GET /projects` (list all projects)

**Files:**
- Modify: `src/api/projects.ts` (`listProjectsHandler`), `src/api/router.ts`, `openapi.yaml`
- Reuse: `listProjects()` from `src/db/index.js` (exists on main per #162)
- Test: `src/api/projects.integration.test.ts`

**Interfaces:**
- Consumes: `listProjects(db?): Promise<ProjectListItem[]>` (confirm the exact return type in `src/db/queries/projects.ts` — it backs the MCP `list_projects` tool).
- Produces: `listProjectsHandler(req, res)` → `ApiResponse<ProjectListItem[]>`.

- [ ] **Step 1:** First **cross-check `openapi.yaml`** for an existing `/projects` `get:` (Agent disagreement). If documented-but-unrouted, this task *also* fixes a contract-gate latent failure — note it in the PR.
- [ ] **Step 2:** Write the failing integration test (`GET /projects` → 200, `data` is an array; create one project in setup and assert it appears).
- [ ] **Step 3:** Run it; verify it fails (404).
- [ ] **Step 4:** Add `listProjectsHandler` (reuse `listProjects()`), register `router.get('/projects', listProjectsHandler)` **above** `'/projects/:id'` is unnecessary (distinct paths) but keep grouping tidy.
- [ ] **Step 5:** Document `GET /projects` in `openapi.yaml`.
- [ ] **Step 6:** Run tests + lint → pass. **Step 7:** Commit. (PR-2.)

### Task 4: `PATCH /libraries/:id` + `POST /libraries/clients` (PR-3)

**Design notes (resolve before coding):**
- `PATCH /libraries/:id` rename — decide via ADR-015 whether renaming a `client` library also rewrites `owner` (island did). If unclear, rename `name` only and leave `owner` immutable; document the choice.
- `POST /libraries/clients` — **do not** look up "Default Company Master" by literal name (island idiosyncrasy). Resolve the parent via `resolveDefaultLibraryId()` (exists per #92) or require an explicit `parentLibraryId` in the body. Validate with Zod; `409` on unique-name violation (`23505`).

**Files:** `src/db/queries/libraries.ts` (`updateLibraryName`; reuse `createLibrary`/`resolveDefaultLibraryId`), `src/api/libraries.ts` (two handlers), `src/api/router.ts`, `openapi.yaml`, tests.

- [ ] TDD each handler (failing test → implement → pass), one commit per endpoint, mapping PG `23505`→409 and unknown id→404. Document both in `openapi.yaml`. Reference (don't copy) `git show ae6a066^:src/api/libraries.ts`.

### Task 5: `PUT /projects/:id/sources` (PR-4)

**Design notes:** replaces a project's ordered `source_library_ids` (the priority list that drives broken-ref `availableFrom`). Decide whether re-ordering sources should re-resolve already-derived specs (likely **no** — copies are immutable per ADR-015 D2; sources only affect *future* resolution + the broken-ref advisory). Document this in the PR.

**Files:** `src/db/queries/projects.ts` (`setProjectSources`), `src/api/projects.ts` (`setProjectSourcesHandler`, Zod `SetProjectSourcesBodySchema = { sourceLibraryIds: string[] }`), `src/api/router.ts`, `openapi.yaml`, integration test (create project → PUT new source order → GET project shows updated sources).

- [ ] TDD: failing integration test → `setProjectSources` (transactional replace, validate library ids exist → 422 otherwise) → handler (404 missing project) → openapi → pass → commit.

---

## Track B — Design gates (no code until the ADR merges)

For each, the deliverable of the *first* task is a merged ADR under `docs/adr/NNN-*.md` (Status/Context/Decision/Consequences), then a follow-up implementation plan written against that ADR. The island implementation at `ae6a066^` is an **input to the design discussion, not the design.**

- [ ] **ADR — required-sections (#8).** Decide: is "required sections" a first-class authored table, or derived from division-general (ADR-023) + design-package membership (ADR-015 D4)? If first-class, design the table + `GET/PUT /projects/:id/required-sections` (+ package variants) from scratch. Consider the scoped-profile pattern. File the missing tracking issue.
- [ ] **ADR/promote — coordination-report (#105, #7).** Vet #105 out of Backlog. Specify the report's finding classes and response contract independently (the island's three classes — present-not-required / required-not-present / dangling-ref — are a reference). Depends on the required-sections ADR.
- [ ] **ADR — project settings & mutability (#9).** Decide whether `PATCH /projects/:id` exists and whether `section_number_format` is a column (island mig 032) or part of a scoped settings/profile. 
- [ ] **ADR — master spec hard-delete custody (#10).** Define what `DELETE /specs/:id` does to derived copies / lineage before exposing it.

---

## Track C — Demo adjustments (one PR, `examples/` only)

Repoint `examples/web_ui_demo/js/api.js` (and any callers in `app.js`) so the demo conforms to main's contract:

- [ ] `getSpecTree(specId)` → `GET /specs/${specId}` (drop the `/tree` suffix; the single-spec endpoint already returns the tree). Adjust any response-shape access if `getSpecHandler` wraps the tree differently.
- [ ] Spec listing: replace `GET /specs` usage with per-library (`GET /libraries/:id/specs`, after PR-1) and project-TOC (`GET /projects/:id`) listing.
- [ ] Reference removal: replace `DELETE /specs/:id/references/:refId` with a paragraph edit (`PATCH /specs/:id/paragraphs/:nodeId`) that drops the citation text; refs re-derive server-side.
- [ ] Remove the `DELETE /specs/:id/paragraphs/:nodeId` call (defer to the editability program); use existing edit ops.
- [ ] Coordination panel: guard the `coordination-report` / `required-sections` fetches so a `404` renders an empty/"not yet available" state instead of erroring.

---

## Self-Review

- **Coverage:** every one of the 14 demo-required endpoints has a verdict + a task or design gate; the "already on main" set is enumerated so nothing is silently dropped.
- **Placeholder scan:** Track A tasks carry concrete code/commands; Track B intentionally has no TDD steps (design-gated — writing fabricated steps for an undesigned ADR would be a plan failure). This is called out explicitly.
- **Type consistency:** `Library`, `LibrarySpec`, `ProjectListItem`, `SetProjectSourcesBodySchema` are named identically across the tasks that define and consume them. Each "reuse" of a main DB fn says "confirm the exact signature in source" because those signatures weren't re-verified line-by-line here.
- **Open verification for the implementer:** (a) confirm `listLibraries`/`listProjects`/`resolveDefaultLibraryId` exact exports on current main; (b) confirm whether `openapi.yaml` already documents `GET /projects`; (c) re-derive island SQL against main's current schema rather than pasting.
