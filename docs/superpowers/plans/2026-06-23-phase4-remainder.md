# Phase 4 Remainder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up the demo's remaining capabilities by flipping the coordination panel on, adding project rename, and gating master-spec deletion behind a soft-delete/withdraw ADR — per `docs/superpowers/specs/2026-06-23-phase4-remainder-disposition-design.md`.

**Architecture:** Three independently-shippable PRs in sequence: PR-A flips one demo flag (`examples/`-only); PR-B1 adds `PATCH /projects/:id {name}` (Express handler + DB fn + `openapi.yaml` + integration test) and flips `projectSettings`; PR-C0 authors **ADR-030** (soft-delete/withdraw custody) — the design gate before any deletion code. The substantial C **implementation** (migration + withdraw handler + read-path filters + restore) gets its own plan written against the *merged* ADR-030. Two items (B2 persisted section-number-format, D paragraph delete) are filed as deferred issues, no code.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, node-pg-migrate, PostgreSQL, hand-authored `openapi.yaml` (CI contract gate), Vitest (unit + integration), vanilla-JS demo under `examples/web_ui_demo` (unlinted).

## Global Constraints

- **`openapi.yaml` is authoritative + CI-enforced** (ADR-026): every route change is documented in the same PR — route↔spec bidirectional coverage + response-schema validation (`src/api/contract.integration.test.ts`). Code conforms to the spec.
- **Module-boundary errors** (`src/lib/errors.ts`): handlers map via `pgErrorToHttp`; chain `cause`. Validate external input with Zod. Stack traces never leave the process.
- **Module imports only via sibling `index.ts` barrels** — `../db/index.js`, never `../db/queries/foo.js`.
- **ESLint enforced (src/ only):** `complexity` ≤ 10, `cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, `no-console` error, `no-explicit-any` error, no non-null `!`. `examples/` is unlinted.
- **TS strict+**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (relative imports end `.js`; `import type` for type-only). Use `z.uuid()` not `z.string().uuid()`.
- **PRs ≤ ~500 LOC** real change, one demonstrable change. Branch `feat/…`/`docs/…` off `origin/main`; never commit to main. Conventional Commits scoped to the module. Credit the agent: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Integration tests need real Postgres**, run in order: `pnpm migrate → pnpm seed → pnpm test → pnpm test:integration`. (`pnpm seed` is mandatory before integration.)
- **ADRs required for non-obvious decisions** — Track B (C) is gated on a merged ADR before code.

## File Structure

| File | PR | Responsibility |
|---|---|---|
| `examples/web_ui_demo/js/features.js` | A, B1 | Capability flags — flip `coordination`, then `projectSettings`. |
| `examples/web_ui_demo/js/app.js` | B1 | `saveProjectSettings` drops the section-number-format field. |
| `examples/web_ui_demo/index.html` | B1 | Remove the `#project-number-format` control. |
| `src/db/queries/projects.ts` | B1 | Add `updateProjectName(id, name, pool)`. |
| `src/db/index.ts` | B1 | Barrel-export `updateProjectName`. |
| `src/api/projects.ts` | B1 | Add `patchProjectHandler` + inline `PatchProjectBody` Zod schema. |
| `src/api/router.ts` | B1 | Register `router.patch('/projects/:id', …)`. |
| `src/api/projects.integration.test.ts` | B1 | Integration coverage for PATCH. |
| `openapi.yaml` | B1 | Document `PATCH /projects/{id}`. |
| `docs/adr/030-spec-soft-delete-withdraw.md` | C0 | The custody ADR (gate for C implementation). |

---

## PR-A — Coordination panel flag-flip (`examples/` only)

Branch: `chore/demo-coordination-flag`. Shape was verified field-by-field against `#241` in the disposition spec §3 — this is flip + smoke test only.

### Task A1: Flip the coordination flag

**Files:**
- Modify: `examples/web_ui_demo/js/features.js`

- [ ] **Step 1: Flip the flag**

In `examples/web_ui_demo/js/features.js`, change the `coordination` line:

```js
  coordination: true, // coordination-report + required-sections            (landed #239/#241)
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check examples/web_ui_demo/js/features.js`
Expected: no output (exit 0).

- [ ] **Step 3: Smoke-test against a seeded DB**

```bash
# Terminal 1 — API
pnpm migrate && pnpm seed && pnpm build
PORT=3000 node dist/index.js
# Terminal 2 — demo
cd examples/web_ui_demo && PORT=3001 SPECR_API_BASE=http://127.0.0.1:3000 node server.mjs
```

In the browser at `http://127.0.0.1:3001`: create a project, drop a `.SEC`/DOCX so a spec parses onto the board, author at least one required section, open the **Coordination** panel.
Expected: summary line (`N TOTAL` + three chips) and the three finding groups render; **zero console errors, zero 404 XHRs**.

- [ ] **Step 4: Commit**

```bash
git add examples/web_ui_demo/js/features.js
git commit -m "chore(examples): enable coordination panel — backend landed (#239/#241)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR-B1 — `PATCH /projects/:id { name }` + demo flip

Branch: `feat/api-project-rename`. `projects.name` is `notNull text` and **not unique**, so there is no 409 path — only 404 (unknown project) and 400 (invalid body). The body is `{ name }` **only**; `sectionNumberFormat` is intentionally omitted (deferred to B2).

### Task B1.1: The endpoint (TDD)

**Files:**
- Test: `src/api/projects.integration.test.ts` (add a `describe('PATCH /projects/:id')`)
- Modify: `src/db/queries/projects.ts`, `src/db/index.ts`, `src/api/projects.ts`, `src/api/router.ts`, `openapi.yaml`

**Interfaces:**
- Consumes: `findProjectById(id, pool): Promise<ProjectWithToc | null>` (exists), `pool` and `pgErrorToHttp` (already imported in `projects.ts`).
- Produces: `updateProjectName(id: string, name: string, pool: Queryable): Promise<{ id: string; name: string } | null>` (null when no row matched); `patchProjectHandler(req, res): Promise<void>` → `ApiResponse<{ projectId: string; name: string }>`.

- [ ] **Step 1: Write the failing integration test**

Append to `src/api/projects.integration.test.ts` (mirror the file's existing `fetch(baseUrl…)` style and its project-creation helper; create a project inline if no helper exists):

```typescript
describe('PATCH /projects/:id', () => {
  it('renames a project', async () => {
    const created = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Original Name', sourceLibraryIds: [DEFAULT_COMPANY_LIBRARY] }),
    }).then((r) => r.json());
    const id = created.data.projectId ?? created.data.id;

    const res = await fetch(`${baseUrl}/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Project' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ projectId: id, name: 'Renamed Project' });
  });

  it('404s an unknown project', async () => {
    const res = await fetch(`${baseUrl}/projects/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s an empty name', async () => {
    const created = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P', sourceLibraryIds: [DEFAULT_COMPANY_LIBRARY] }),
    }).then((r) => r.json());
    const id = created.data.projectId ?? created.data.id;
    const res = await fetch(`${baseUrl}/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});
```

> Confirm `DEFAULT_COMPANY_LIBRARY` and the project-create response field (`projectId` vs `id`) against the existing tests in this file before running; adjust the inline helper to match.

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test:integration -- projects`
Expected: FAIL — the PATCH returns 404 (route not registered) for the rename case.

- [ ] **Step 3: Add the DB function**

In `src/db/queries/projects.ts` (mirror the parameterized style of `setProjectSources`; reuse the module's `Queryable` type):

```typescript
export async function updateProjectName(
  id: string,
  name: string,
  pool: Queryable
): Promise<{ id: string; name: string } | null> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `UPDATE projects SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, name`,
    [id, name]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Barrel-export it**

In `src/db/index.ts`, add `updateProjectName` to the existing `export { … } from './queries/projects.js'` block.

- [ ] **Step 5: Add the handler + schema**

In `src/api/projects.ts`, add near the top (mirroring `RenameLibraryBody` in `libraries.ts`):

```typescript
const PatchProjectBody = z.object({ name: z.string().check(z.minLength(1)) });
```

Import `updateProjectName` and `findProjectById` from `../db/index.js` (extend the existing import block), then add:

```typescript
export async function patchProjectHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id) {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  const parsed = PatchProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'name is required' });
    return;
  }
  try {
    const updated = await updateProjectName(id, parsed.data.name, pool);
    if (!updated) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: { projectId: updated.id, name: updated.name } });
  } catch (err) {
    logger.error({ err }, 'patch project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

- [ ] **Step 6: Register the route**

In `src/api/router.ts`, beside the other `/projects/:id` routes, add the import and:

```typescript
router.patch('/projects/:id', patchProjectHandler);
```

- [ ] **Step 7: Document in `openapi.yaml`**

Under `/projects/{id}`, add a `patch:` operation (mirror the existing `PATCH /libraries/{id}` op): `requestBody` → object with required `name` (string, minLength 1); responses `200` → `ApiResponse` whose `data` is `{ projectId: string, name: string }`, `400`, `404`. Reuse existing `ApiResponse`/error components.

- [ ] **Step 8: Run tests + lint**

Run: `pnpm test:integration -- projects` → PASS (all three cases).
Run: `pnpm lint` → clean, including the contract gate `src/api/contract.integration.test.ts` (route↔spec match).

- [ ] **Step 9: Commit**

```bash
git add src/db/queries/projects.ts src/db/index.ts src/api/projects.ts src/api/router.ts src/api/projects.integration.test.ts openapi.yaml
git commit -m "feat(api): PATCH /projects/:id — rename a project

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B1.2: Flip the demo (examples-only)

**Files:**
- Modify: `examples/web_ui_demo/js/app.js`, `examples/web_ui_demo/index.html`, `examples/web_ui_demo/js/features.js`

- [ ] **Step 1: Drop the format field from `saveProjectSettings`**

In `examples/web_ui_demo/js/app.js`, in `saveProjectSettings`, remove the `sectionNumberFormat` read and send `{ name }` only:

```js
  const name = document.getElementById('project-name-input')?.value.trim() || activeProjectName();
  projectClientLibraryIds = checkedProjectClientIds();
  try {
    await patchProject(activeProjectId, { name });
```

(Delete the `const sectionNumberFormat = …` line and drop it from the `patchProject` body.)

- [ ] **Step 2: Remove the now-unused control**

In `examples/web_ui_demo/index.html`, remove the `#project-number-format` `<select>` (and its label). Grep first: `grep -n "project-number-format" examples/web_ui_demo/index.html examples/web_ui_demo/js/app.js` and remove the markup + any remaining reference (e.g. `activeSectionNumberFormat`) so no dead handler remains.

- [ ] **Step 3: Flip the flag**

In `examples/web_ui_demo/js/features.js`:

```js
  projectSettings: true, // PATCH /projects/:id {name}                          (landed)
```

- [ ] **Step 4: Syntax-check**

Run: `node --check examples/web_ui_demo/js/app.js && node --check examples/web_ui_demo/js/features.js`
Expected: exit 0.

- [ ] **Step 5: Smoke-test** — with the API + demo servers running (as in Task A1 Step 3), rename the active project from the demo; confirm the board header updates and no console error fires. The format dropdown is gone.

- [ ] **Step 6: Commit**

```bash
git add examples/web_ui_demo/js/app.js examples/web_ui_demo/index.html examples/web_ui_demo/js/features.js
git commit -m "chore(examples): enable project rename; format is a generate-time choice

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PR-C0 — ADR-030: spec soft-delete / withdraw (design gate)

Branch: `docs/adr-030-spec-soft-delete`. This authors the ADR only. **No deletion code** lands until ADR-030 is merged; the C **implementation** plan is written against the merged ADR.

### Task C0: Author ADR-030

**Files:**
- Create: `docs/adr/030-spec-soft-delete-withdraw.md`

- [ ] **Step 1: Write the ADR** (content drawn from disposition spec §5)

```markdown
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
layered-spec-hierarchy *chain-of-custody*: hard-deleting a master destroys the
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
  read path, and a `restore` path. Reads that must filter are enumerated above
  and re-confirmed in the implementation plan.
- No hard-delete escape hatch ships now; if a true purge is ever needed it is a
  separate, custody-reviewed decision.
```

- [ ] **Step 2: Prettier-check the doc**

Run: `pnpm prettier --check docs/adr/030-spec-soft-delete-withdraw.md` (or `pnpm format`).
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/030-spec-soft-delete-withdraw.md
git commit -m "docs(adr): ADR-030 — spec soft-delete/withdraw (Track B gate, specDelete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Open the ADR PR, drive review to green, merge.** Only then write the C-implementation plan (migration → withdraw handler → `restore` → read-path filters → `openapi.yaml` → tests → flip `specDelete`) against the merged ADR.

---

## Deferred housekeeping (no code)

### Task HK: File the two deferred issues

- [ ] **B2 issue** — `feat(api): persist a default section_number_format as a scoped output policy`. Body: renderer already accepts `sectionNumberFormat` per-`generate` (`GenerateBodySchema`); persistence belongs to the scoped style/output profile (#125, ADR-021), not a bare `projects` column. Labels: type:feat, area:api, priority per board. Add to the Project board (Backlog).
- [ ] **D issue** — `feat(editability): paragraph removal lifecycle (vanish vs delete)`. Body: #135–#140 delivered classification, not deletion; paragraph removal should be designed in the editability program (ADR-022, #128–#147), most likely as `meta.vanish` to match the soft-delete philosophy. Labels: type:feat, area:editability. Add to the board (Backlog).

```bash
gh issue create --title "feat(api): persist default section_number_format as a scoped output policy" --body "<as above; references #125, ADR-021>" --label "type:feat,area:api"
gh issue create --title "feat(editability): paragraph removal lifecycle (vanish vs delete)" --body "<as above; references ADR-022, #128-147>" --label "type:feat,area:editability"
```

---

## Self-Review

- **Spec coverage:** §3 A → PR-A; §4 B1 → PR-B1 (B2 → Task HK); §5 C → PR-C0 (C implementation explicitly deferred to its own post-ADR plan); §6 D → Task HK. All four flags accounted for; nothing dropped.
- **Placeholder scan:** every code step shows real code; the one "confirm against existing tests" note (B1.1 Step 1) is a verification instruction, not a stand-in for missing content. C-implementation is *intentionally* not stubbed — writing fabricated migration/filter steps before ADR-030 merges would be a plan failure (mirrors the conformance roadmap's Track-B discipline).
- **Type consistency:** `updateProjectName(id, name, pool) → { id, name } | null` defined in B1.1 Step 3, consumed by `patchProjectHandler` in Step 5; handler emits `{ projectId, name }` matching the test in Step 1 and the `openapi.yaml` schema in Step 7. `PatchProjectBody = { name }` (no `sectionNumberFormat`) is consistent across handler, test, openapi, and the demo flip.
- **Open for the implementer:** confirmed `projects.name` is not unique → no 409 path (resolved). Confirm the project-create response field (`projectId` vs `id`) in the existing integration tests before running B1.1. The `restore` endpoint ships within the C-implementation PR (not a follow-up), per ADR-030.
```
