# Draft Issues — Library Hierarchy, Keynoting, Publishing, Coordination, Concurrency

> **STATUS: FILED 2026-06-05.** This file is the design record. Filed mapping:
> 2d-i #92 · 2d-ii #93 · 2d-iii #94 · 2d-iv #95 · 2d-v #96 · 2d-vi #97 ·
> K-i #98 · K-ii #99 · K-iii #106 · P-i #100 · P-ii #101 · P-iii #102 ·
> L-i #103 · L-ii #104 · coordination report #105 · concurrency #107 ·
> BL-1 #108 · BL-2 #109 · BL-3 #110. Extension comments posted on #84 and #52.
> Labels `phase:2d` / `phase:2e` created. Each issue is one sub-MVP (≤500 LOC,
> independently CI-green, test plan required).

Anchored on: ADR-015 (hierarchy + custody), ADR-016 (keynoting), ADR-017 (publishing),
ADR-018 (concurrency), ADR-019 (scope boundaries).

---

## Phase 2d — layered hierarchy + chain of custody (ADR-015)

### 2d-i — `feat(db): libraries table — reference/company/client tiers + library_id on specs`

Label: `phase:2d` · Blocked by: — · Blocks: 2d-ii…vi, K-i

**Context:** ADR-015 D1. All specs live in one flat `(section, source)` namespace; the
tier schema ADR-006 required was never built.

**Scope:**
- Migration: `libraries` table (tier CHECK `reference|company|client`, `name`, `owner`,
  nullable `parent_library_id`), `specs.library_id` + `specs.project_id` (XOR CHECK).
- Backfill: `source='ufgs'` specs → built-in `UFGS Reference` library (tier `reference`);
  all others → `Default Company Master` (tier `company`).
- Replace `UNIQUE (section, source)` with partial unique indexes per ADR-015 D1.
- `src/db/queries/libraries.ts` (create/find/list) + barrel re-export.

**Acceptance:**
- [ ] `pnpm migrate` up/down clean; every existing spec assigned a library
- [ ] Integration test: same section number exists in two libraries without conflict
- [ ] XOR constraint rejects a spec with both/neither owner

**Out of scope:** copy-on-derive behavior (2d-iii), ingest `libraryId` param (2d-iii), UI.

### 2d-ii — `feat(db): spec lineage — parent_spec_id, origin_version, content_version, origin_meta`

Label: `phase:2d` · Blocked by: 2d-i · Blocks: 2d-iii, 2d-vi

**Context:** ADR-015 D2. The only provenance today is `specs.source` (format origin).
Chain of custody needs a derivation edge + drift baseline + ingest provenance.

**Scope:**
- Migration: `parent_spec_id` self-FK, `origin_version INTEGER`, `content_version INTEGER
  NOT NULL DEFAULT 1`, `origin_meta JSONB`.
- Wire `content_version` bump into `persistParsedSpec` and all paragraph-mutating writes.
- Loader/parse paths populate `origin_meta` (`filename`, `sha256`, loader id).

**Acceptance:**
- [ ] Persisting a parsed spec bumps `content_version`; re-upsert bumps again
- [ ] `origin_meta` recorded by `load_files` and `POST /parse` paths
- [ ] Migration up/down clean

**Out of scope:** lineage read API (2d-vi), clone semantics (2d-iii).

### 2d-iii — `feat(db): copy-on-derive — project sections become owned copies via project_sources resolution`

Label: `phase:2d` · Blocked by: 2d-i, 2d-ii · Blocks: 2d-iv

**Context:** ADR-015 D2/D3. `addSpecToProject` currently aliases the shared library row —
project edits mutate the master every other project sees. Projects must own copies, and
project creation must accept an ordered source list (company only, client only, or both
with per-section fallback).

**Scope:**
- Migration: `project_sources(project_id, library_id, priority)`.
- `POST /projects` accepts ordered `sourceLibraryIds`; persisted to `project_sources`.
- `addSpecToProject(section)`: resolve per-section through priority order → clone spec +
  paragraph tree → set `parent_spec_id`/`origin_version` → `project_specs` row points at
  the clone. Multi-source shadow surfaced as advisory in the response.
- Backfill migration: existing aliased project rows cloned into owned copies w/ lineage.
- Scope-aware cross-reference resolution (project copies first, then source libraries).
- `openapi.yaml` contract update.

**Acceptance:**
- [ ] Adding a section clones (new spec id, identical content, lineage set)
- [ ] Editing the project copy leaves the master untouched (regression test)
- [ ] Fallback test: section absent from client master resolves from company master
- [ ] Backfill converts an existing aliased project; up/down clean

**Out of scope:** re-pull/rebase command, packages (2d-iv).

### 2d-iv — `feat(db): design packages — issuable subsets of the project TOC`

Label: `phase:2d` · Blocked by: 2d-iii · Blocks: 2d-v

**Context:** ADR-015 D4. A project issues multiple packages (bid packages, early
releases); membership is a subset/reorder of the project TOC.

**Scope:**
- Migration: `design_packages` + `package_specs` per ADR-015 D4.
- Queries + REST: `POST/GET /projects/:id/packages`, `PUT /packages/:id/specs` (ordered
  membership), `DELETE /packages/:id`.

**Acceptance:**
- [ ] Package holds an ordered subset; a spec may belong to two packages
- [ ] Membership restricted to specs of the same project (integration test)
- [ ] Migration up/down clean

**Out of scope:** issuance snapshots (2d-v), manual rendering (ADR-017).

### 2d-v — `feat(api): package revisions — immutable issuance snapshots`

Label: `phase:2d` · Blocked by: 2d-iv · Coordinate with: #36 (separate grain — see ADR-015 D5)

**Context:** ADR-015 D5. "50% DD" / "100% CD" / "Addendum 2" must be reproducible
point-in-time records of exactly what was issued.

**Scope:**
- Migration: `package_revisions` + `package_revision_specs` (frozen `SpecTree` JSONB).
- `POST /packages/:id/revisions { label }` snapshots every member section's tree.
- `GET /revisions/:id` returns frozen trees; Zod-validate JSONB on read.
- Set `lifecycle_state='issued'` hook deferred to the ADR-018 issue.

**Acceptance:**
- [ ] Snapshot immutable: post-issuance paragraph edits do not alter the stored tree
- [ ] `UNIQUE (package_id, label)` enforced
- [ ] Round-trip: snapshot tree re-validates against `SpecTreeSchema`

**Out of scope:** addenda rendering (P-iii), DOCX artifact caching (#52).

### 2d-vi — `feat(api): chain-of-custody surfacing — lineage endpoint + MCP tool`

Label: `phase:2d` · Blocked by: 2d-ii

**Context:** ADR-015 D6. Custody must be auditable by humans and AI agents.

**Scope:**
- `GET /specs/:id/lineage` → `{ chain: [{ specId, scope (library|project), name, contentVersion, originVersion, behindBy }], originMeta }`,
  walking `parent_spec_id` to the root.
- MCP tool `get_spec_lineage(specId)` returning the same payload.

**Acceptance:**
- [ ] Three-hop fixture (company → client → project) returns full chain with correct `behindBy`
- [ ] Ingested-root spec returns `origin_meta` as chain origin
- [ ] MCP integration test (JSON-RPC `tools/call`)

**Out of scope:** rebase/re-pull actions.

---

## Keynoting (ADR-016)

### K-i — `feat(db): keynote master table + project-filtered keynote query`

Label: proposed `phase:2d` follow-on · Blocked by: 2d-i

**Scope:** `keynotes` migration per ADR-016 D1; `getProjectKeynotes(projectId)` filtering
by source libraries + TOC membership (ADR-016 D2); barrel export.

**Acceptance:**
- [ ] Keynote targeting a section not in the project TOC is excluded
- [ ] `UNIQUE (library_id, code)` enforced; up/down clean

**Out of scope:** export format (K-ii), Revit sync (K-iii), keynote file import.

### K-ii — `feat(api): project keynote export — keynote table file + MCP tool`

Label: proposed `phase:2d` follow-on · Blocked by: K-i

**Scope:** `GET /projects/:id/keynotes` renders the tab-delimited keynote table (code,
description, parent code) consumed by BIM authoring tools; MCP `get_project_keynotes`
returns structured rows.

**Acceptance:**
- [ ] Deterministic fixture: known keynotes + TOC → exact expected file body
- [ ] Hierarchy (parent codes) preserved; MCP integration test

**Out of scope:** element assignment sync (K-iii).

### K-iii — `feat(revit): keynote assignment sync — element keynote params via parameter mappings`

Label: `phase:4` · Blocked by: #48, K-ii

**Scope:** add-in reads/writes element keynote parameters; assignments persisted through
the `revit_parameter_mappings` pattern so element↔keynote↔spec joins surface in the link
inventory (L-i).

**Acceptance:**
- [ ] Assignment round-trip: set in model → visible via L-i read model
- [ ] Keynote pointing outside project TOC flagged in coordination report (X-84)

**Out of scope:** keynote legends, drawing-side artifacts.

---

## Publishing (ADR-017) — proposed new label `phase:2e`

### P-i — `feat(generator): multi-section manual assembly — ordered sections, per-section numbering restart`

Label: proposed `phase:2e` · Blocked by: — (draft mode renders from existing `project_specs`)

**Scope:** `generateManual(projectId)` v1: iterate ordered TOC, reuse per-section
emitters, OOXML section breaks, per-section numbering instances (distinct abstractNum per
section — the known sharp edge, ADR-017 Consequences), `w:sdt` anchors preserved.

**Acceptance:**
- [ ] Two-section fixture: both sections present, numbering restarts at PART 1 in each
- [ ] Every paragraph still wrapped in its UUID anchor
- [ ] Single DOCX buffer streams from `POST /projects/:id/generate`

**Out of scope:** cover/TOC page (P-ii), issuance/addenda (P-iii), PDF.

### P-ii — `feat(generator): manual front matter — cover page + TOC field`

Label: proposed `phase:2e` · Blocked by: P-i

**Scope:** cover page from project metadata + style template; Word TOC field over section
headings (Word paginates on open — SpecR asserts structure, not page numbers).

**Acceptance:**
- [ ] Generated OOXML contains TOC field code + one entry per section in TOC order
- [ ] Cover carries project name/description; style template applied

**Out of scope:** custom cover designer (style templates own presentation).

### P-iii — `feat(generator): issuance + addenda rendering from package revisions`

Label: proposed `phase:2e` · Blocked by: P-ii, 2d-v

**Scope:** render a manual from a frozen `package_revision` (reproducible issuance);
addendum mode renders only sections changed vs a base revision (AST inequality), under an
addendum cover listing affected sections.

**Acceptance:**
- [ ] Re-rendering an old revision after DB edits reproduces the issued content
- [ ] Addendum fixture: 1 of 3 sections changed → addendum contains exactly that section
- [ ] Issuance label appears in headers/footers

**Out of scope:** paragraph-level change bars (Phase 3 diff reuse, later).

---

## Revit link inventory

### L-i — `feat(api): revit link inventory — element↔spec mapping read model`

Label: `phase:4` · Blocked by: — (schema exists, #46 closed)

**Scope:** `GET /projects/:id/revit-links` (and by-element / by-spec filters) joining
`revit_parameter_mappings` → paragraphs → specs; MCP tool `list_revit_links`. Read-only.

**Acceptance:**
- [ ] Seeded mappings fixture returns element→sections and section→elements views
- [ ] Unmapped-element + spec-without-model-backing counts exposed (feeds X-84)

**Out of scope:** UI (L-ii), mapping mutation.

### L-ii — `feat(ui): revit link browser — element↔spec navigation`

Label: `phase:5` · Blocked by: #38, L-i

**Scope:** UI page listing model elements ↔ linked specs/paragraphs with filter/search;
drill-through to spec tree view (#39).

**Acceptance:**
- [ ] Element list ↔ spec list pivots both directions
- [ ] Unlinked items visually flagged

**Out of scope:** editing mappings from the console (follow-up).

---

## Extensions to existing issues

### X-84 — comment on #84, then follow-up issue `feat(api): project coordination report`

Proposed comment on #84:

> Scope extension proposal: #84's missing-required-sections preflight is one signal of a
> broader coordination surface. Follow-up issue will aggregate into
> `GET /projects/:id/coordination-report` + MCP tool: (1) missing required sections (#84
> core), (2) broken cross-references (existing query), (3) unmapped Revit elements /
> specs without model backing (L-i), (4) parse warnings + inference conflicts (#56), (5)
> keynotes whose target section left the TOC (ADR-016). #84 lands unchanged; the report
> consumes it.

Follow-up issue: label `phase:4` · blocked by #84, L-i · acceptance: report fixture with
one defect of each class → five typed findings.

### X-52 — comment on #52 + new issue `feat(api): document concurrency — optimistic writes, advisory locks, lifecycle state`

Proposed comment on #52:

> Reframe per ADR-018: cache locking is a consumer of the document concurrency model, not
> its own design. Invalidation keys off `specs.content_version` (ADR-015); in-flight-write
> protection comes from optimistic preconditions. #52 scope shrinks to pre-generation +
> storage + invalidation triggers. Prerequisite issue: document concurrency (below).

New issue: label `phase:5` (pre-req for #44) · blocked by 2d-ii ·
**Scope:** version preconditions on all content writes (REST + MCP, `409` on stale);
`spec_locks` advisory TTL table + acquire/release/steal-after-expiry; `lifecycle_state`
column (`draft|issued|archived`) + issuance hook (2d-v) + composed edit gate with
ADR-014 `external_state`.
**Acceptance:** stale-version write rejected w/ current version; second holder refused
while lock live, succeeds after expiry; archived spec rejects writes; `openapi.yaml`
updated before #44 starts.

---

## Backlog (no phase label)

### BL-1 — `feat(generator): SpecsIntact .SEC output renderer`

AST → SpecsIntact XML (`<PRT>/<SPT>/<TXT>`) — the inverse of the existing parser. Enables
delivery into SpecsIntact-mandated workflows. Acceptance: parse→generate→re-parse
round-trip on UFGS fixtures yields identical trees. Unscheduled; kept per ADR-019.

### BL-2 — `feat(db): external content association — link firm documents to paragraphs/sections`

Association model: paragraph/spec ↔ external document reference (DMS connector identity,
ADR-014 `external_id` pattern, or URL + hash). SpecR stores links + provenance, never the
bytes as product content (ADR-019). Acceptance: associate a datasheet ref to a Part 2
paragraph; surfaced in `get_paragraph` + spec tree responses.

### BL-3 — `feat(lib): subscription content ingestion adapter — BYO-license master updates into firm libraries`

Adapter seam (ADR-014 plug-in philosophy applied to content sources): firms with their own
subscription to a master-content/standards service connect credentials and pull
updates into their own libraries (ADR-015) with `origin_meta` provenance. Per-firm
entitlement; no redistribution (ADR-019). Requires a per-provider research spike before
any adapter is built. Acceptance criteria defined per adapter at spike time.
