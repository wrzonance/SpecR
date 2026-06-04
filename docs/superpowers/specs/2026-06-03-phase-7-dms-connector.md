# Phase 7 — Pluggable DMS Connector Framework — Phased Issue Breakdown

**Date:** 2026-06-03
**Status:** DRAFT — issue bodies below are not yet filed. Review, then `gh issue create`.
**Design:** [ADR-014](../../adr/014-dms-connector-framework.md) — Pluggable DMS Connector Framework (ProjectWise Reference Plugin).

## Summary

Phase 7 adds a connector **framework** (`packages/connector-core`) plus a ProjectWise
**reference plugin** (`packages/connector-projectwise`) that ingests documents from a
DMS into SpecR (`POST /parse`) and pushes regenerated / merged versions back
(`generate_docx` → new version). The connector is out-of-process, talks only to
SpecR's REST + MCP surface, and never touches the DB. Provider richness (permissions,
approval workflows, locking, retention, attributes) is modeled as capability-gated
extension points; a write-guard preflight runs before every push. The one core change
is a set of generic `external_*` columns on `specs` (ADR-014 D5).

Repo becomes a pnpm workspace as part of 7a.

## Conventions / housekeeping before filing

- **New label `phase:7`** must be created (`gh label create "phase:7" --description "Phase 7 issues"`). Net-new; no `phase:7` exists today.
- **New title scope `(connector)`** — net-new; no existing issue uses it. `7-core` uses `(db)` because it is a core schema change, not a connector change.
- One `phase:7` label per issue, no `type:` label (type lives in the `feat(...)` prefix), matching house convention.
- Body skeleton matches existing Phase 4 issues (#48, #82): `## Context` → `## Scope` (bold **Create:/Modify:** + file bullets) → `## Acceptance` (`- [ ]`) → `## Test plan` → `## Doc updates (in-scope)` → `## Blocked by` → `## Out of scope`.

## Dependency graph

```text
#35, #36 (Phase 3) ─────────────┐
                                 ▼
7-core ──► 7c ──┐            ┌► 7e
                ├────────────┤
7a ──► 7b ──────┴► 7d ───────┘
  └──► 7f (second plugin; provider TBD)
```

- **7-core** — no deps (core schema)
- **7a** — no deps (framework scaffold; converts repo to workspace)
- **7b** — 7a
- **7c** — 7b, 7-core
- **7d** — 7b
- **7e** — 7c, 7d, **#35**, **#36**
- **7f** — 7a

## What blocks implementation (from ADR-014)

No connector code until supplied: (1) deployment type (on-prem WSG / PW365 / greenfield
iTwin); (2) live WSG MetaSchema discovery (API version, repo id, real `Document`
property set, workflow/state class names — UNCONFIRMED in public docs, auth scheme,
plug-in version); (3) test creds + non-prod datasource (WSG) or registered service app
(iTwin); (4) per-second-plugin research spike before 7f.

---

# Draft Issue 1 (Epic) — `feat(connector): Phase 7 — pluggable DMS connector framework (epic)`

**Labels:** `phase:7`

## Context

Engineering firms keep spec documents in a DMS (Bentley ProjectWise, Autodesk ACC/APS,
Microsoft SharePoint/Graph, generic stores). SpecR should ingest from and push back to
these systems without manual file shuffling. Per ADR-014, this is a pluggable framework
(`connector-core`) with one plugin per DMS, ProjectWise first. The connector is
out-of-process, brokers SpecR's REST + MCP surface, and never reaches the DB.

## Value

- Documents flow from the firm's CDE into SpecR and regenerated/merged versions flow back.
- The product respects upstream governance (locked / pending-approval / retained docs).
- New DMSs are added as plugins without touching core (Open/Closed).

## Scope (tracking only — work happens in sub-issues)

- **7-core** generic external linkage + `external_state` on `specs`
- **7a** `connector-core` framework + capability model + repo → pnpm workspace
- **7b** ProjectWise ingest path
- **7c** ProjectWise version-out path
- **7d** ProjectWise write-guard layer (access-control / lifecycle / locking / retention)
- **7e** round-trip wiring into Phase 3 merge
- **7f** second plugin — abstraction acceptance test

## Dependencies

- Hard-gates 7e on Phase 3 (#35 diff, #36 merge).
- Production SpecR-side auth aligns with #43 (Phase 5f).

## Risks

- Over-abstraction before a second plugin exists — mitigated by making 7f the acceptance test.
- WSG schema/URLs are deployment-specific — runtime MetaSchema discovery mandatory.
- w:sdt anchors (ADR-004) must survive the DMS round-trip.

## Out of scope

- Any connector code before the "What blocks implementation" inputs (ADR-014) are supplied.
- A `/connectors` route inside `specr` core (generic endpoint lives in `connector-core`).

---

# Draft Issue 2 — `feat(db): Phase 7-core — generic external linkage + external_state on specs`

**Labels:** `phase:7`

## Context

Per ADR-014 D5, to let the product respect upstream DMS governance, a connector mirrors a
**provider-agnostic** status onto the spec. This is the only change to `specr` core and
also stores the doc↔spec mapping (`external_id`). Core stores/returns these fields; the
connector populates them. No core code path branches on `external_provider` — core stays
DMS-agnostic in behavior.

## Scope

**Create:**
- `src/db/migrations/NNN_add_specs_external_linkage.sql` (+ reversible down): add to `specs`
  - `external_provider TEXT` — opaque provider key (e.g. `'projectwise'`)
  - `external_id TEXT` — provider doc id (the mapping)
  - `external_state TEXT` — closed enum `editable | locked | pending-review | retained | read-only`; `CHECK` constraint
  - `external_metadata JSONB` — provenance labels + preserved provider attrs (opaque)
  - `external_synced_at TIMESTAMPTZ`
  - partial index on `(external_provider, external_id)` for reverse lookup

**Modify:**
- `src/db/queries/specs.ts` — read/return `external_*` in `getSpecTree` / spec fetch; add `setExternalLinkage(specId, {...})` query; export via `src/db/index.ts`.
- Paragraph-edit path (`src/api/specs.ts` PATCH and/or the future `PATCH /specs/:id/paragraphs/:nodeId`, #47) — refuse edits when `external_state` is non-writable (`locked|pending-review|retained|read-only`) → `409`.
- `src/ast/types.ts` + `schemas.ts` — surface `external` block on the spec/tree type (generic enum, opaque metadata).

## Acceptance

- [ ] Migration applies and rolls back cleanly (`pnpm migrate` / `pnpm migrate:down`).
- [ ] `external_state` `CHECK` rejects out-of-enum values.
- [ ] `getSpecTree` returns the `external_*` block (omitted/empty when unset — wire economy).
- [ ] PATCH to a paragraph of a spec with non-writable `external_state` → `409` with a clear error.
- [ ] `setExternalLinkage` upserts the five fields idempotently.

## Test plan

```bash
pnpm migrate && pnpm migrate:down && pnpm migrate
pnpm test
pnpm test:integration   # spec external-linkage read/write + edit-guard 409
pnpm lint
```

## Doc updates (in-scope)

- `ARCHITECTURE.md` Database Schema section — add the `external_*` columns to the `specs` DDL block.
- `openapi.yaml` — add the `external` block to the spec response schema.

## Blocked by

- none

## Out of scope

- Any provider-specific state names (core only stores the generic enum).
- The connector that populates these fields (7c).

---

# Draft Issue 3 — `feat(connector): Phase 7a — connector-core framework (DmsConnector, capability registry, AuthProvider, SpecrClient)`

**Labels:** `phase:7`

## Context

The framework that every DMS plugin implements (ADR-014 D1–D3). Defines the tiny base
interface (four verbs), the capability model (write-guards / provenance / eventing),
pluggable `AuthProvider`, a typed `SpecrClient` over SpecR's REST surface, and the sync
orchestrator with the write-guard preflight. No live DMS calls — validated against a mock
plugin. Converts the repo to a pnpm workspace.

## Scope

**Create:**
- Convert repo to pnpm workspace: `pnpm-workspace.yaml` `packages:` glob; move the existing app under the workspace (or keep root app + add `packages/`). CI runs per-package.
- `packages/connector-core/` package:
  - `src/types.ts` — `DmsConnector`, `DocRef`, `ContainerRef`, `Capability`, `LifecycleState`, `LockState`, `RetentionState`, `ProvenanceMeta`, `CustomAttributes`.
  - `src/auth.ts` — `AuthProvider` interface (`getAuthHeaders()`).
  - `src/registry.ts` — capability-aware plugin registry.
  - `src/specr-client.ts` — typed REST client (openapi-derived, `openapi-fetch`): `parse(file)` + poll, `generate(specId)`, `setExternalLinkage(...)`; Phase 3 `diff`/`merge` added in 7e.
  - `src/orchestrator.ts` — ingest + version-out flows + `runWriteGuardPreflight(plugin, doc)`.
  - `src/config.ts` — Zod base config; per-plugin config composition.
  - `src/index.ts` — public exports.
  - `test/mock-plugin.ts` + unit tests for capability gating + preflight degradation.

**Modify:**
- root `package.json` / CI workflow — workspace-aware scripts (`pnpm -r build|test|lint`).

## Acceptance

- [ ] `pnpm -r build` builds core + workspace.
- [ ] Mock plugin with a subset of capabilities: orchestrator routes only to declared capabilities, degrades (logs + surfaces) on absent ones.
- [ ] `runWriteGuardPreflight` refuses (typed error) when any declared write-guard fails; passes when all pass; skips absent guards with a logged note.
- [ ] `SpecrClient` parse-poll-generate exercised against a stub HTTP server.
- [ ] No import from `specr` `src/db/` anywhere in `connector-core` (lint boundary check).

## Test plan

```bash
pnpm --filter connector-core build
pnpm --filter connector-core test     # capability gating, preflight, mock plugin
pnpm -r lint
```

## Doc updates (in-scope)

- `packages/connector-core/README.md` — interface + capability model overview, link ADR-014.

## Blocked by

- none

## Out of scope

- Any real DMS plugin (7b+).
- The deployable HTTP sync-service (library + CLI first per ADR-014 D2; service after ≥2 plugins).

---

# Draft Issue 4 — `feat(connector): Phase 7b — ProjectWise plugin ingest (WSG schema discovery → POST /parse)`

**Labels:** `phase:7`

## Context

ProjectWise reference plugin, ingest path. WSG is dynamic ECObjects — schema/class/property
names and the API-version segment are deployment-specific and must be discovered at runtime
from MetaSchema (ADR-014 D6 / "what blocks implementation"). Plugin lists documents, downloads
file bytes (`$file`), and feeds `POST /parse`, then polls the job.

## Scope

**Create:**
- `packages/connector-projectwise/`:
  - `src/wsg-client.ts` — HTTP client for WSG (base URL, version segment).
  - `src/schema-resolver.ts` — `ServiceVersions` → `Repositories` → `MetaSchema/ECClassDef` discovery; resolves repo id, `Document` property set, relationship names. **No hardcoded URLs.**
  - `src/auth/` — `WsgBasicAuthProvider`, `WsgTokenAuthProvider` (IMS/STS + `Mas-App-Guid`/`Mas-Uuid` headers).
  - `src/plugin.ts` — implements `DmsConnector` base verbs `list` / `fetch` / `identify`; declares capabilities (write-guards added in 7d).
  - `src/config.ts` — Zod config (server URL, datasource/repo, auth mode + creds).
  - tests against recorded WSG fixtures (no live server in CI).

**Modify:**
- `connector-core` orchestrator — wire the ingest flow end-to-end with this plugin behind a feature flag / config.

## Acceptance

- [ ] `schema-resolver` discovers API version + repo id + `Document` props from MetaSchema fixtures; fails loudly (typed error) when a required class/relationship is absent.
- [ ] `list(container)` returns `DocRef[]` for a folder/project.
- [ ] `fetch(doc)` downloads bytes (Range/ETag honored) + provider meta.
- [ ] Ingest flow: `fetch` → `POST /parse` → poll → spec persisted; `external_provider='projectwise'` + `external_id` written via `setExternalLinkage`.
- [ ] Both auth providers produce correct headers (unit-tested).

## Test plan

```bash
pnpm --filter connector-projectwise test    # schema discovery + list + fetch (fixtures)
pnpm --filter connector-core test           # ingest flow with PW plugin (stubbed WSG + stubbed SpecR)
pnpm -r lint
```

## Doc updates (in-scope)

- `packages/connector-projectwise/README.md` — config + the runtime-discovery prerequisite.

## Blocked by

- #<7a>

## Out of scope

- Version-out (7c), write-guards (7d), round-trip (7e).
- Live-server integration (depends on customer datasource — see ADR-014 blockers).

---

# Draft Issue 5 — `feat(connector): Phase 7c — ProjectWise plugin version-out (generate_docx → WSG new version)`

**Labels:** `phase:7`

## Context

Version-out path: generate a DOCX from the stored spec and push it back to ProjectWise as a
new version, preserving the w:sdt UUID anchors (ADR-004) and the document's provider
attributes. Writes the generic `external_state` back to core.

## Scope

**Create:**
- `packages/connector-projectwise/src/upload.ts` — WSG `$changeset` transaction (new `Document` version) + resumable chunked `$file` PUT (Content-Range / If-Match / 308→200); optional `Mas-Allow-Redirect` 307 direct path.
- `packages/connector-projectwise/src/provenance.ts` — map version label + custom attributes ↔ `external_metadata` (preserve on push).

**Modify:**
- `connector-core` orchestrator — version-out flow: `generate(specId)` → `plugin.push(doc, bytes, meta)` → `setExternalLinkage` (state + version label).
- `src/plugin.ts` — implement `push`.

## Acceptance

- [ ] `push` creates a new ProjectWise version (changeset + chunked upload) against WSG fixtures.
- [ ] Generated DOCX round-trips with w:sdt anchors intact (verify tags present post-upload payload).
- [ ] Provider attributes captured on `fetch` are re-attached on `push` (not stripped).
- [ ] After push, `external_state` + provenance label written to core via `setExternalLinkage`.

## Test plan

```bash
pnpm --filter connector-projectwise test   # changeset + chunked upload + provenance map (fixtures)
pnpm --filter connector-core test          # version-out flow (stubbed WSG + stubbed SpecR)
pnpm -r lint
```

## Doc updates (in-scope)

- `packages/connector-projectwise/README.md` — version-out + attribute-preservation notes.

## Blocked by

- #<7b>
- #<7-core> (needs `setExternalLinkage` + `external_*`)

## Out of scope

- Write-guard preflight (7d) — this issue assumes the doc is writable; 7d adds the gate.
- Round-trip diff/merge (7e).

---

# Draft Issue 6 — `feat(connector): Phase 7d — ProjectWise write-guard layer (access-control, lifecycle, locking, retention)`

**Labels:** `phase:7`

## Context

Pushing must never clobber a document the firm's governance protects (ADR-014 D4). This adds
the four write-guard capabilities to the ProjectWise plugin and routes them through the
orchestrator's preflight. The WSG "sharp edge": lifecycle/workflow state is NOT in the base
`Document` GET — it requires a separate relationship-expand query on the workflow class
(names discovered from MetaSchema; UNCONFIRMED in public docs).

## Scope

**Create:**
- `packages/connector-projectwise/src/guards/` —
  - `access-control.ts` → `assertWritable(doc)` (effective perms for the connector identity).
  - `lifecycle.ts` → `getLifecycleState(doc)` via separate workflow-class query; map native stages → generic `{ state, isWritable, allowedTransitions }`; optional `requestTransition`.
  - `locking.ts` → `getLock(doc)` (`IsLocked` + checkout owner).
  - `retention.ts` → `getRetention(doc)` (hold/immutability).
- declare capabilities `access-control` / `lifecycle-state` / `locking` / `retention` on the plugin.

**Modify:**
- `connector-core` orchestrator preflight — already calls declared guards (7a); verify ProjectWise wiring; map composite result → core `external_state` enum.

## Acceptance

- [ ] `getLifecycleState` issues the separate workflow query (not the base Document GET) and maps stages onto the generic enum.
- [ ] Preflight refuses push (typed, human-readable reason) for: no edit permission / mid-approval / locked-by-other / under retention hold.
- [ ] Composite writability maps to the correct core `external_state` (`locked|pending-review|retained|read-only|editable`).
- [ ] Absent capability (simulated) → orchestrator degrades + logs, does not crash.

## Test plan

```bash
pnpm --filter connector-projectwise test   # each guard + workflow-state query (fixtures)
pnpm --filter connector-core test          # preflight refuse/allow matrix
pnpm -r lint
```

## Doc updates (in-scope)

- `packages/connector-projectwise/README.md` — the separate-state-query requirement + capability list.

## Blocked by

- #<7b>

## Out of scope

- Round-trip merge (7e). Provider attribute mapping (7c).

---

# Draft Issue 7 — `feat(connector): Phase 7e — round-trip wiring into Phase 3 merge`

**Labels:** `phase:7`

## Context

Closes the loop: a redlined document returned to the DMS is fetched, diffed against the stored
spec (Phase 3 `POST /specs/:id/diff`), and accepted changes merged (`POST /specs/:id/merge`).
The push of the merged result is lifecycle-aware (runs the 7d preflight). Hard-gated on Phase 3.

## Scope

**Create:**
- `connector-core` orchestrator `roundTrip(doc, specId)` flow: `fetch` redline → `SpecrClient.diff` → present → `SpecrClient.merge(accept[])` → regenerate → lifecycle-aware `push`.
- `packages/connector-projectwise` — round-trip integration test against WSG + Phase 3 fixtures.

**Modify:**
- `connector-core/src/specr-client.ts` — add `diff(specId, file)` + `merge(specId, accept[])`.

## Acceptance

- [ ] End-to-end: ingest → generate → (simulated owner edit) → return → diff → merge → push new version.
- [ ] Push step runs the 7d preflight; refuses if the target is non-writable.
- [ ] Position-fallback path exercised when w:sdt anchors are absent (degraded mode per ADR-004).

## Test plan

```bash
pnpm --filter connector-core test
pnpm --filter connector-projectwise test
pnpm -r lint
```

## Doc updates (in-scope)

- `ARCHITECTURE.md` — note the DMS round-trip flow as a connector consumer of Phase 3.

## Blocked by

- #<7c>
- #<7d>
- #35 (Phase 3b — `POST /specs/:id/diff`)
- #36 (Phase 3c — `POST /specs/:id/merge`)

## Out of scope

- Conflict-resolution UI (Phase 5, #40).
- Second plugin (7f).

---

# Draft Issue 8 — `feat(connector): Phase 7f — second DMS plugin (abstraction acceptance test, provider TBD)`

**Labels:** `phase:7`

## Context

The connector abstraction is provisional until a second plugin exercises it (ADR-014 D8).
This issue is the acceptance test: implement a second provider behind the same `DmsConnector`
interface and report any interface revisions it forced. Provider TBD — ACC/APS, SharePoint/Graph,
or iTwin Storage — chosen after the ProjectWise plugin (7a–7e) proves the interface.
**Requires its own research spike first** (CRUD + permission/approval/locking/retention/attribute
models for the chosen provider).

## Scope

**Create:**
- `packages/connector-<provider>/` implementing `DmsConnector` + an `AuthProvider`.
- Declares only the capabilities the provider actually supports (e.g. iTwin Storage: no lifecycle, in-place versioning).

**Modify:**
- `connector-core` interfaces — only if the second provider proves a gap; document each change.

## Acceptance

- [ ] Second plugin passes the same orchestrator ingest + version-out flows.
- [ ] Capability degradation verified (a guard the provider lacks is skipped + surfaced, not faked).
- [ ] Interface revisions (if any) documented; `connector-core` consumers notified of breaking changes pre-1.0.

## Test plan

```bash
pnpm --filter connector-<provider> test
pnpm --filter connector-core test
pnpm -r lint
```

## Doc updates (in-scope)

- `packages/connector-<provider>/README.md`; update ADR-014 D8 status (abstraction ratified).

## Blocked by

- #<7a>
- (provider research spike — separate prerequisite, see ADR-014 blockers)

## Out of scope

- Building all candidate providers — exactly one second plugin to validate the abstraction.
