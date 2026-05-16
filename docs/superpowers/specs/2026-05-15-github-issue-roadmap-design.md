# Design: GitHub Issue Roadmap — Phases 1c through 5

**Date:** 2026-05-15  
**Scope:** Full SpecR roadmap from Phase 1c-iii cleanup through Phase 5 Web UI  
**Approach:** A+C — one issue per sub-MVP (1:1 with PRs), doc updates bundled into each issue

---

## Current State

Merged: Phase 0, 1a, 1b, 1c-i, 1c-ii, security hardening (#23), Phase 2a, Phase 2b-i (#26).

**Not yet built (no files):**
- `src/generator/controls.ts` — w:sdt UUID injection (Phase 2b-ii)
- `src/merge/` — 3-way diff + conflict resolution (Phase 3)
- `src/api/diff.ts` + `src/api/merge.ts` — diff/merge endpoints (Phase 3)
- DOCX cross-reference extraction (Phase 1c-iii, orphaned)
- Style template engine (Phase 2c — meta-issue #20 to be decomposed)

**Existing open issues to action:**
- #20 (Phase 2c meta-issue): close with note, replace with 3 sub-issues
- #13 (ADR-011 docs): leave open, links to Phase 6 (out of scope)

---

## Milestones

| Milestone | Purpose |
|-----------|---------|
| Phase 1c | DOCX parser completion (orphaned 1c-iii) |
| Phase 2b | Core DOCX generator (2b-ii content controls, 2b-iii MCP tools) |
| Phase 2c | Firm style template engine |
| Phase 3 | Round-trip merge engine |
| Phase 4 | Revit integration |
| Phase 5 | Web UI |

---

## Issue Set (24 issues)

### Phase 1c

#### Issue A — `feat(parser): Phase 1c-iii — DOCX cross-reference extraction`

**Milestone:** Phase 1c  
**Blocked by:** nothing  
**Blocks:** nothing (independent of critical path)

**Context:**  
The .SEC parser extracts cross-references into `spec_references` at parse time. The DOCX parser does not. Parity is required before DOCX-sourced specs can participate in broken-reference detection (`GET /projects/:id/references/broken`).

**Scope:**  
Create:
- none

Modify:
- `src/parser/docx/index.ts` — run `SECTION_REF_RULES` regex over extracted paragraph text after hierarchy inference; insert rows into `spec_references`
- `tests/integration/parse.integration.test.ts` — fixture DOCX with known cross-refs; assert `spec_references` rows

**Acceptance criteria:**
- Parse a DOCX containing "See Section 09 91 00" → `spec_references` row with `target_spec_section = '09 91 00'`
- Parse a DOCX containing `ASTM C150` → `spec_references` row with `standard_code = 'ASTM C150'`
- No regression in existing parse integration tests

**Test plan:**
```bash
pnpm test:integration
```
- Verify `spec_references` rows created for fixture DOCX

**Doc updates (in-scope):**
- `README.md`: update "What Works Today" → Parsing bullet for DOCX
- `openapi.yaml`: no changes needed (no new endpoints)

---

### Phase 2b

#### Issue B — `feat(generator): Phase 2b-ii — w:sdt content control UUID injection`

**Milestone:** Phase 2b  
**Blocked by:** nothing  
**Blocks:** Issue H (Phase 3a)

**Context:**  
The 3-way merge engine (Phase 3) needs stable paragraph identifiers that survive round-trips through Word/LibreOffice/Google Docs. ADR-004 specifies OOXML content controls (`w:sdt`) with a custom `specr-uuid-<id>` tag as the anchor mechanism. Phase 2b-i generates valid DOCX with CSI numbering but does not inject content controls. This issue adds the missing piece.

**Scope:**  
Create:
- `src/generator/controls.ts` — `wrapWithControl(paragraph: Paragraph, uuid: string): XmlComponent` — wraps a dolanmiu/docx `Paragraph` in a `w:sdt` element with `<w:tag w:val="specr-uuid-{uuid}"/>`, `<w:alias w:val="SpecR paragraph"/>`, and `<w:lock w:val="sdtContentLocked"/>`
- `src/generator/controls.test.ts` — unit tests: verify `w:sdt` XML structure in emitted buffer

Modify:
- `src/generator/index.ts` — call `wrapWithControl(para, node.id)` for each emitted paragraph before adding to `children[]`
- `tests/integration/generate.integration.test.ts` — add test: generate DOCX, unzip buffer, parse `word/document.xml`, assert `w:sdt` elements present with correct `w:tag` values

**Acceptance criteria:**
- Generate DOCX from any spec → unzip → every `<w:p>` is wrapped in `<w:sdt><w:sdtPr><w:tag w:val="specr-uuid-..."/></w:sdtPr><w:sdtContent>...</w:sdtContent></w:sdt>`
- Content of `w:tag` matches the `CsiNode.id` for each paragraph
- Open in Word: each paragraph shows a content control boundary; tag is visible in Developer tab
- No regression in existing generator tests

**Test plan:**
```bash
pnpm test                # unit: controls.test.ts
pnpm test:integration    # integration: generate.integration.test.ts
```

**Doc updates (in-scope):**
- `README.md`: move "AST → DOCX generator + content controls" from "Not Yet Built" to "What Works Today"
- `ARCHITECTURE.md`: update Phase 2b status; note content controls complete
- `docs/adr/004-content-controls-as-merge-anchors.md`: update Status to "Implemented Phase 2b-ii"

---

#### Issue C — `feat(mcp): Phase 2b-iii — MCP get_paragraph + parse_document tools`

**Milestone:** Phase 2b  
**Blocked by:** nothing  
**Blocks:** nothing (independent of critical path)

**Context:**  
ADR-010 specifies `get_paragraph` and `parse_document` as Phase 2b MCP tools. README lists them as "Phase 2b follow-up." `get_paragraph` gives AI agents per-paragraph context with ancestor chain. `parse_document` lets AI agents upload and parse specs without the REST multipart API.

**Scope:**  
Modify:
- `src/mcp/tools.ts` — add two tools:
  - `get_paragraph(paragraph_id: string)` → `{ node: CsiNode, ancestors: CsiNode[] }` — query paragraph by UUID, reconstruct ancestor chain via parent_id chain in DB
  - `parse_document(filename: string, content_base64: string)` → `{ spec_id, section, title, node_count }` — base64-decode, detect format (.docx/.sec), call parser, return summary
- `src/mcp/tools.test.ts` — integration tests for both tools via `POST /mcp` JSON-RPC

**Acceptance criteria:**
- `get_paragraph` with valid UUID returns node + full ancestor chain
- `get_paragraph` with unknown UUID returns `isError: true`
- `parse_document` with base64-encoded UFGS .SEC file parses and returns spec summary
- `parse_document` with invalid base64 returns `isError: true`

**Test plan:**
```bash
pnpm test:integration
```

**Doc updates (in-scope):**
- `README.md`: remove `get_paragraph` + `parse_document` from "Not Yet Built"
- `ARCHITECTURE.md`: update MCP tools list in Phase 2a description

---

### Phase 2c

#### Issue D — `feat(db): Phase 2c-i — style_templates + style_rules migrations + default CSI seed`

**Milestone:** Phase 2c  
**Blocked by:** nothing  
**Blocks:** Issues E, F

**Context:**  
Generator currently uses hardcoded CSI default styles. Issue #20 (meta-issue) identified the need for per-firm style templates. This issue creates the DB schema; subsequent issues add the API and generator wiring.

**Scope:**  
Create:
- `src/db/migrations/NNNN_style_templates.sql` — `style_templates` table (id, name, owner, created_at) + `style_rules` table (id, template_id, node_type, font_family, font_size_pt, bold, indent_twips, space_before_pt, space_after_pt, numbering_format)
- `src/db/migrations/NNNN_style_templates.down.sql` — reversible rollback
- `src/db/migrations/NNNN_seed_default_csi_styles.sql` — insert default template + one rule per NodeType reflecting current hardcoded values

Modify:
- `src/db/queries/` — add `src/db/queries/templates.ts`: `getTemplate(id)`, `listTemplates()`, `createTemplate()`, `upsertStyleRule()`
- `src/db/index.ts` — re-export template queries

**Acceptance criteria:**
- `pnpm migrate` succeeds; `pnpm migrate:down` reverses cleanly
- Default template seed row present with all 7 node_type rules
- `getTemplate('default')` returns the seeded template

**Test plan:**
```bash
pnpm migrate
pnpm test:integration    # DB query tests for getTemplate, listTemplates
```

**Doc updates (in-scope):**
- `ARCHITECTURE.md`: update Phase 2c description with DB schema detail
- `openapi.yaml`: no endpoint changes yet

---

#### Issue E — `feat(api): Phase 2c-ii — template CRUD API`

**Milestone:** Phase 2c  
**Blocked by:** Issue D  
**Blocks:** Issue F

**Context:**  
Firms need to create and configure style templates via API before the generator can apply them. This issue adds the REST endpoints. Template import from `.dotx` files is deferred (Phase 2c follow-up).

**Scope:**  
Create:
- `src/api/templates.ts` — handlers: `createTemplateHandler`, `listTemplatesHandler`, `getTemplateHandler`, `upsertStyleRuleHandler`
- `tests/integration/templates.integration.test.ts`

Modify:
- `src/api/router.ts` — add routes: `POST /templates`, `GET /templates`, `GET /templates/:id`, `POST /templates/:id/rules`
- `src/ast/schemas.ts` — Zod schemas: `CreateTemplateBodySchema`, `UpsertStyleRuleBodySchema`
- `openapi.yaml` — document new endpoints

**Acceptance criteria:**
- `POST /templates` creates a template, returns `{ success: true, data: { id, name } }`
- `POST /templates/:id/rules` upserts a rule for a given `node_type`
- `GET /templates/:id` returns template with all rules
- 404 on unknown template ID

**Test plan:**
```bash
pnpm test:integration    # templates.integration.test.ts
```

**Doc updates (in-scope):**
- `README.md`: add template endpoints to "API" section
- `openapi.yaml`: all four endpoints documented

---

#### Issue F — `feat(generator): Phase 2c-iii — wire templateId through generator`

**Milestone:** Phase 2c  
**Blocked by:** Issues D, E  
**Blocks:** Issue T (Phase 5d)

**Context:**  
`POST /specs/:id/generate` already accepts `{ templateId? }` in the request body (per ARCHITECTURE.md) but ignores it. This issue loads the template from DB and applies its rules to font, spacing, indent, and numbering format in the generated DOCX.

**Scope:**  
Modify:
- `src/api/generate.ts` — parse `templateId?` from body; pass to `generateDocx`
- `src/generator/index.ts` — accept optional `StyleTemplate` arg; apply font/spacing rules to each paragraph
- `src/generator/numbering.ts` — accept optional numbering format overrides from template rules
- `src/ast/schemas.ts` — add `GenerateBodySchema` with optional `templateId: z.uuid().optional()`
- `tests/integration/generate.integration.test.ts` — add test: generate with explicit templateId, verify response

**Acceptance criteria:**
- `POST /specs/:id/generate` with `{ "templateId": "<default-id>" }` produces identical output to no-template (default = current hardcoded styles)
- `POST /specs/:id/generate` with custom template applies font/spacing from `style_rules` rows
- `POST /specs/:id/generate` with unknown templateId → 404

**Test plan:**
```bash
pnpm test:integration
```

**Doc updates (in-scope):**
- `README.md`: update Phase 2c row to "Complete"
- `openapi.yaml`: document `templateId` in generate request body

---

### Security (no milestone)

#### Issue G — `chore(security): parse worker concurrency cap — piscina follow-up to #23`

**Milestone:** none (standalone security issue)  
**Blocked by:** nothing  
**Blocks:** nothing

**Context:**  
Issue #22 / PR #23 added rate limiting and yauzl validation. Remaining gap per README: unbounded concurrent parse workers. Large DOCX files on concurrent requests can exhaust Node.js memory. piscina provides a worker thread pool with a concurrency cap.

**Scope:**  
Create:
- `src/lib/parse-pool.ts` — piscina `Piscina` instance, `MAX_WORKERS = Math.max(1, os.cpus().length - 1)`; exports `runParse(input)` that delegates to worker

Modify:
- `src/api/parse.ts` — replace direct `parse()` call with `runParse()` from pool
- `package.json` — add `piscina` dependency

**Acceptance criteria:**
- Concurrent parse requests capped at `cpu_count - 1` workers
- Single parse request still completes correctly
- Out-of-pool requests queue (piscina default) rather than spawn

**Test plan:**
```bash
pnpm test:integration    # existing parse integration tests pass
```

**Doc updates (in-scope):**
- `README.md`: remove piscina concurrency from "Not Yet Built"

---

### Phase 3

#### Issue H — `feat(merge): Phase 3a — merge module core (UUID match + 3-way diff)`

**Milestone:** Phase 3  
**Blocked by:** Issue B (content controls needed for UUID extraction tests)  
**Blocks:** Issue I

**Context:**  
ADR-005 specifies a git-style 3-way merge: base_version (DB snapshot) + theirs (returned DOCX) + ours (current DB). This issue implements the pure algorithm and the DOCX UUID extraction utility. No HTTP endpoints yet.

**Scope:**  
Create:
- `src/merge/error.ts` — `MergeError extends SpecrError`
- `src/merge/types.ts` — `DiffResult { added: ParagraphDiff[], modified: ModifiedDiff[], deleted: string[], conflicts: ConflictDiff[] }`, `ParagraphDiff`, `ModifiedDiff`, `ConflictDiff`
- `src/merge/extract.ts` — `extractContentControls(docxBuffer: Buffer): Map<string, string>` — unzip DOCX buffer, parse `word/document.xml`, return `Map<uuid, plainText>` from all `w:sdt[w:tag^="specr-uuid-"]` elements
- `src/merge/diff.ts` — `computeDiff(base: ParagraphSnapshot[], ours: CsiNode[], theirs: Map<string, string>): DiffResult`
- `src/merge/index.ts` — re-export public API
- `src/merge/diff.test.ts` — unit tests: known base/theirs/ours inputs → expected `DiffResult`
- `src/merge/extract.test.ts` — unit test: generate DOCX via `generateDocx`, call `extractContentControls`, verify UUID map

Modify:
- `src/db/queries/versions.ts` — ensure `getParagraphSnapshots(specId, version)` exists; add if missing

**Acceptance criteria:**
- `computeDiff` correctly classifies: theirs-only change → `modified` (auto-accept); both-changed → `conflicts`; missing UUID → `deleted`; new paragraph (no UUID) → `added`
- `extractContentControls` returns correct UUID→text map from a SpecR-generated DOCX buffer
- No HTTP dependency; fully unit-testable

**Test plan:**
```bash
pnpm test    # unit: diff.test.ts, extract.test.ts
```

**Doc updates (in-scope):**
- `ARCHITECTURE.md`: update Phase 3 description; note merge module structure
- `docs/adr/005-git-style-3-way-merge.md`: update Status to "In progress — Phase 3a"

---

#### Issue I — `feat(api): Phase 3b — POST /specs/:id/diff + MCP get_spec_diff + specr://diff resource`

**Milestone:** Phase 3  
**Blocked by:** Issue H  
**Blocks:** Issue J

**Context:**  
First half of the HTTP surface for the merge engine. Client uploads an edited DOCX; endpoint parses it, extracts content control UUIDs, runs 3-way diff against DB state, returns structured diff.

**Scope:**  
Create:
- `src/api/diff.ts` — `diffHandler`: validate spec ID, receive multipart DOCX upload (reuse `multer`), call `extractContentControls` + `computeDiff`, return `DiffResult`
- `tests/integration/diff.integration.test.ts`

Modify:
- `src/api/router.ts` — add `POST /specs/:id/diff`
- `src/mcp/tools.ts` — add `get_spec_diff(spec_id)` tool → calls same diff logic, returns `DiffResult`
- `src/mcp/resources.ts` — add `specr://specs/{id}/diff` resource → `DiffResult` as JSON
- `openapi.yaml` — document endpoint + request/response schema

**Acceptance criteria:**
- Upload unmodified SpecR-generated DOCX → `{ added: [], modified: [], deleted: [], conflicts: [] }`
- Upload DOCX with one paragraph text changed → `modified` array contains that paragraph with base/theirs/ours fields
- Upload DOCX with one paragraph deleted → `deleted` array contains UUID
- Upload non-DOCX → 422

**Test plan:**
```bash
pnpm test:integration    # diff.integration.test.ts
```

**Doc updates (in-scope):**
- `README.md`: add `POST /specs/:id/diff` to API table
- `ARCHITECTURE.md`: update Phase 3b status
- `openapi.yaml`: diff endpoint + DiffResult schema

---

#### Issue J — `feat(api): Phase 3c — POST /specs/:id/merge + base_version tracking`

**Milestone:** Phase 3  
**Blocked by:** Issue I  
**Blocks:** Issue K, Issue S (Phase 5c)

**Context:**  
Second half of the merge HTTP surface. Client submits UUIDs of accepted changes; endpoint applies them to `paragraphs` rows and bumps `base_version`. Rejected changes are discarded.

**Scope:**  
Create:
- `src/merge/conflict.ts` — `applyAccepted(specId, acceptedIds, diff): { applied: number, rejected: number }` — updates `paragraphs.text` for accepted UUIDs; inserts snapshot into `paragraph_versions`; increments `base_version`
- `src/api/merge.ts` — `mergeHandler`: validate spec ID + body `{ accept: string[] }`, call `applyAccepted`, return summary
- `tests/integration/merge.integration.test.ts`

Modify:
- `src/api/router.ts` — add `POST /specs/:id/merge`
- `openapi.yaml` — document endpoint

**Acceptance criteria:**
- Accept one UUID from diff → paragraph text updated in DB, `base_version` incremented
- Reject all → no DB change, `{ applied: 0, rejected: N }`
- Unknown UUID in accept list → 400 with descriptive error
- `paragraph_versions` snapshot inserted for each accepted change

**Test plan:**
```bash
pnpm test:integration    # merge.integration.test.ts
```

**Doc updates (in-scope):**
- `README.md`: add `POST /specs/:id/merge` to API table; update Phase 3 status row
- `docs/adr/005-git-style-3-way-merge.md`: update Status to "Implemented Phase 3c"

---

#### Issue K — `test: Phase 3d — end-to-end round-trip integration test`

**Milestone:** Phase 3  
**Blocked by:** Issue J  
**Blocks:** Issue Q (Phase 5a)

**Context:**  
Proves the entire value proposition: parse → generate → edit → diff → merge → verify. This is the milestone acceptance test for Phase 3 and the PR that updates Phase 3 status to complete in all docs.

**Scope:**  
Create:
- `tests/integration/roundtrip.integration.test.ts` — full scenario:
  1. Parse UFGS .SEC fixture → `spec_id`
  2. `POST /specs/:id/generate` → DOCX buffer
  3. Mutate buffer: unzip, change one paragraph text, rezip
  4. `POST /specs/:id/diff` with mutated buffer → assert `modified` contains changed paragraph
  5. `POST /specs/:id/merge` with accepted UUID → assert `{ applied: 1 }`
  6. `GET /specs/:id` → assert paragraph text updated in DB

**Acceptance criteria:**
- Full scenario passes end-to-end
- Test is deterministic (fixture-based, no random data)
- Test documents which Word/LibreOffice content control survival is assumed (comment in test)

**Test plan:**
```bash
pnpm test:integration    # roundtrip.integration.test.ts
```

**Doc updates (in-scope):**
- `README.md`: update Phase 3 status row to "Complete ✅"; move merge engine from "Not Yet Built"
- `ARCHITECTURE.md`: update Phase 3 completion note
- `docs/adr/004-content-controls-as-merge-anchors.md`: add note on content control survival — which applications tested

---

### Phase 4

#### Issue L — `feat(db): Phase 4a — Revit parameter mapping schema + migrations`

**Milestone:** Phase 4  
**Blocked by:** nothing (independent, start anytime)  
**Blocks:** Issues M, N

**Context:**  
ADR-009 specifies a Revit parameter → CSI paragraph mapping schema. Each mapping binds a Revit parameter name (e.g. `Manufacturer`) to a paragraph UUID and a transform rule (direct substitution, lookup table, conditional).

**Scope:**  
Create:
- `src/db/migrations/NNNN_revit_mappings.sql` — `revit_parameter_mappings(id, spec_id, paragraph_id, revit_param, transform_type, transform_config JSONB)`
- `src/db/migrations/NNNN_revit_mappings.down.sql`
- `src/db/queries/revit.ts` — `getMappings(specId)`, `upsertMapping()`, `deleteMapping()`

Modify:
- `src/db/index.ts` — re-export revit queries
- `src/ast/types.ts` — confirm `meta.revitParam?: string` already present (it is per ARCHITECTURE.md)

**Acceptance criteria:**
- Migration up/down reversible
- `upsertMapping` idempotent on (spec_id, paragraph_id, revit_param)

**Doc updates (in-scope):**
- `ARCHITECTURE.md`: document revit_parameter_mappings table schema

---

#### Issue M — `feat(api): Phase 4b — PATCH /specs/:id/paragraphs/:nodeId individual update endpoint`

**Milestone:** Phase 4  
**Blocked by:** Issue L  
**Blocks:** Issue O

**Context:**  
ADR-009 requires individual paragraph update via UUID — the Revit add-in calls this endpoint to push model parameter changes into spec paragraphs without replacing the whole spec.

**Scope:**  
Create:
- `src/api/paragraphs.ts` — `updateParagraphHandler`: validate spec ID + node UUID, update `paragraphs.text` + `updated_at`, bump `base_version`, return updated node
- `tests/integration/paragraphs.integration.test.ts`

Modify:
- `src/api/router.ts` — add `PATCH /specs/:id/paragraphs/:nodeId`
- `openapi.yaml` — document endpoint

**Acceptance criteria:**
- PATCH with valid IDs + `{ text: "new text" }` → paragraph text updated, `base_version` incremented
- PATCH with unknown nodeId → 404
- PATCH with nodeId not belonging to spec → 403

**Doc updates (in-scope):**
- `README.md`: add endpoint to API table
- `openapi.yaml`: endpoint + request/response schema

---

#### Issue N — `feat(revit): Phase 4c — Revit add-in scaffold (C#/.NET, Revit API, SpecR REST client)`

**Milestone:** Phase 4  
**Blocked by:** Issue L  
**Blocks:** Issue O

**Context:**  
Separate C#/.NET project. Revit add-in (`.addin` manifest + `IExternalApplication`) that connects to a running SpecR instance. REST client generated from `openapi.yaml`. Phase 4c is the scaffold only — no data flow yet.

**Scope:**  
Create:
- `revit-addin/` — new directory (separate C# solution)
  - `SpecRAddin.csproj` — targets Revit API version
  - `App.cs` — `IExternalApplication` with ribbon button
  - `SpecRClient.cs` — typed REST client (NSwag or Refit from openapi.yaml)
  - `SpecRAddin.addin` — Revit manifest

**Acceptance criteria:**
- Add-in loads in Revit without error
- Ribbon button appears in Revit UI
- `SpecRClient.GetSpec(id)` returns deserialized response from running SpecR dev server

**Doc updates (in-scope):**
- `README.md`: add "Revit Add-In" section with setup instructions
- `ARCHITECTURE.md`: update Phase 4 description with add-in project location

---

#### Issue O — `feat(revit): Phase 4d — Part 2 auto-population from Revit family instances`

**Milestone:** Phase 4  
**Blocked by:** Issues M, N  
**Blocks:** Issue P

**Context:**  
Core Phase 4 value: Revit equipment family instances → Part 2 (Products) paragraph population. Reads Revit `FamilyInstance` parameters, maps via `revit_parameter_mappings`, pushes updates to `PATCH /specs/:id/paragraphs/:nodeId`. Shows preview before commit.

**Scope:**  
Modify:
- `revit-addin/` — add `SyncCommand.cs`: reads selected Revit elements, resolves parameter mappings (via `GET /mappings`), diffs current vs. proposed text, shows WPF preview dialog, on confirm calls `PATCH /paragraphs/:nodeId` for each change

**Acceptance criteria:**
- Select Revit equipment → sync command shows preview of paragraph changes
- Confirm → paragraphs updated in DB
- Cancel → no DB change
- Unknown parameter mapping → skipped with log warning

**Doc updates (in-scope):**
- `README.md`: update Phase 4 description

---

#### Issue P — `feat(revit): Phase 4e — Revit change detection + diff preview`

**Milestone:** Phase 4  
**Blocked by:** Issue O  
**Blocks:** nothing

**Context:**  
Ongoing sync: detect when Revit model parameters have changed since last push and surface a diff for spec writer review. Avoids silent overwrites.

**Scope:**  
Modify:
- `revit-addin/` — add `ChangeDetector.cs`: caches last-synced parameter values per element; on next sync compares current Revit values against cache; surfaces diff before allowing push

**Acceptance criteria:**
- Second sync with unchanged model → "No changes detected"
- Second sync with changed Revit parameter → shows only changed parameters in preview

**Doc updates (in-scope):**
- `README.md`: update Phase 4 status to "Complete ✅"

---

### Phase 5

#### Issue Q — `feat(ui): Phase 5a — frontend scaffold (React/TS, Vite, OpenAPI client codegen)`

**Milestone:** Phase 5  
**Blocked by:** Issue K (Phase 3 must be complete)  
**Blocks:** Issues R, S, T, U

**Context:**  
First Phase 5 issue. Establishes the frontend project structure within the monorepo. React + TypeScript + Vite. API client generated from `openapi.yaml` so it stays in sync with the backend contract. No features yet — scaffold only.

**Scope:**  
Create:
- `ui/` — Vite React/TS scaffold
  - `ui/src/api/client.ts` — typed fetch client using `openapi-fetch` (no codegen step; derives types directly from `openapi.yaml` via `openapi-typescript`)
  - `ui/src/App.tsx` — root with React Router
  - `ui/vite.config.ts` — proxy API calls to `http://localhost:3000`

Modify:
- `package.json` — add `ui` workspace
- `docker-compose.yml` — add `ui` service for local dev

**Acceptance criteria:**
- `pnpm --filter ui dev` starts Vite dev server
- `ui/src/api/client.ts` is generated from `openapi.yaml` and typechecks
- `GET /health` call from browser succeeds through proxy

**Doc updates (in-scope):**
- `README.md`: add UI development section

---

#### Issue R — `feat(ui): Phase 5b — spec tree viewer + parse job progress UI`

**Milestone:** Phase 5  
**Blocked by:** Issue Q  
**Blocks:** nothing

**Context:**  
First real UI feature. View a parsed spec as an interactive tree (Part → Article → PR1–PR5 hierarchy). Show parse job progress from `GET /parse/jobs/:jobId` polling.

**Scope:**  
Create:
- `ui/src/pages/SpecPage.tsx` — renders `CsiTree` as collapsible hierarchy
- `ui/src/pages/ParsePage.tsx` — file upload + progress bar polling `/parse/jobs/:jobId`
- `ui/src/components/CsiTree.tsx` — recursive tree node renderer

**Acceptance criteria:**
- Upload DOCX → progress bar fills → redirect to spec tree view
- Spec tree shows Part/Article/PR hierarchy with correct indentation
- Clicking a node expands children

**Doc updates (in-scope):**
- `README.md`: update Phase 5 description

---

#### Issue S — `feat(ui): Phase 5c — diff/merge review interface (3-way conflict resolution)`

**Milestone:** Phase 5  
**Blocked by:** Issues Q, J  
**Blocks:** nothing

**Context:**  
The spec writer's primary review workflow. Upload redlined DOCX, see diff results, accept or reject changes per paragraph.

**Scope:**  
Create:
- `ui/src/pages/DiffPage.tsx` — upload returned DOCX, display `DiffResult`
- `ui/src/components/ConflictCard.tsx` — side-by-side base | theirs | ours for each conflict
- `ui/src/components/DiffSummary.tsx` — counts of added/modified/deleted/conflicts

**Acceptance criteria:**
- Upload DOCX → diff results rendered
- Each conflict shows three versions; user selects which to accept
- Submit → `POST /specs/:id/merge` called with accepted UUIDs
- Confirmation screen shows applied/rejected counts

**Doc updates (in-scope):**
- `README.md`: update Phase 5 description

---

#### Issue T — `feat(ui): Phase 5d — style template configuration UI`

**Milestone:** Phase 5  
**Blocked by:** Issues Q, F  
**Blocks:** nothing

**Context:**  
Firms configure their house style through the UI. Create templates, set per-node-type rules (font, spacing, numbering format). Preview a generated DOCX with the new template before saving.

**Scope:**  
Create:
- `ui/src/pages/TemplatesPage.tsx` — list templates, create new
- `ui/src/pages/TemplateEditorPage.tsx` — per-node-type rule editor; live preview via `POST /specs/:id/generate` with `templateId`

**Acceptance criteria:**
- Create template → appears in list
- Edit rule → generate preview DOCX in browser (download link)

**Doc updates (in-scope):**
- `README.md`: update Phase 5 description

---

#### Issue U — `feat(ui): Phase 5e — firm library management`

**Milestone:** Phase 5  
**Blocked by:** Issue Q  
**Blocks:** nothing

**Context:**  
Browse and manage the paragraph library. Search across specs, view broken cross-references, manage project TOCs.

**Scope:**  
Create:
- `ui/src/pages/LibraryPage.tsx` — search interface over `search_library` MCP tool or `GET /parse`-based search
- `ui/src/pages/ProjectPage.tsx` — TOC management (add/remove specs, reorder)
- `ui/src/pages/BrokenRefsPage.tsx` — list broken cross-references from `GET /projects/:id/references/broken`

**Doc updates (in-scope):**
- `README.md`: update Phase 5 description

---

#### Issue V — `feat(api): Phase 5f — authentication + multi-tenant (JWT, org isolation)`

**Milestone:** Phase 5  
**Blocked by:** nothing (can start anytime; needed before production)  
**Blocks:** Issues W (MCP write tools need auth)

**Context:**  
Multi-firm SaaS requires authentication and org-level data isolation. JWT-based auth for REST API and MCP (ADR-010 auth hook point is already marked in `src/mcp/server.ts`).

**Scope:**  
Create:
- `src/lib/auth.ts` — JWT verify middleware; `req.org` injection
- `src/db/migrations/NNNN_orgs_users.sql` — `orgs`, `users`, `org_memberships` tables
- Auth middleware applied to all routes except `/health`

Modify:
- `src/mcp/server.ts` — fill auth hook at marked insertion point (lines 19–21)
- All DB queries — add `org_id` filter to all spec/project queries

**Acceptance criteria:**
- Unauthenticated request → 401
- Token from org A cannot access specs belonging to org B
- MCP requests with invalid bearer token → MCP error response

**Doc updates (in-scope):**
- `README.md`: add auth section
- `openapi.yaml`: add `BearerAuth` security scheme to all endpoints

---

#### Issue W — `feat(mcp): Phase 5g — MCP write tools (add_paragraph, update_paragraph, delete_paragraph)`

**Milestone:** Phase 5  
**Blocked by:** Issue V (auth required before write tools)  
**Blocks:** nothing

**Context:**  
ADR-010 lists write tools as Phase 5. Enables AI agents to author spec content directly via MCP without the REST API.

**Scope:**  
Modify:
- `src/mcp/tools.ts` — add:
  - `add_paragraph(spec_id, parent_id, node_type, text, position)` → new `CsiNode` UUID
  - `update_paragraph(paragraph_id, text)` → updated node
  - `delete_paragraph(paragraph_id)` → confirmation

**Acceptance criteria:**
- `add_paragraph` inserts row, returns UUID
- `update_paragraph` updates text, bumps `base_version`
- `delete_paragraph` removes row + children (cascade)
- All three reject unauthenticated calls

**Doc updates (in-scope):**
- `README.md`: remove MCP write tools from "Not Yet Built"

---

#### Issue X — `feat(mcp): Phase 5h — MCP stateful sessions + streaming upgrade`

**Milestone:** Phase 5  
**Blocked by:** nothing  
**Blocks:** nothing

**Context:**  
Current MCP transport is stateless (one McpServer per request). Phase 5 UI progress bars and streaming tool responses require stateful sessions. ADR-010 documents the upgrade path as a one-parameter change + session Map.

**Scope:**  
Modify:
- `src/mcp/server.ts` — change `sessionIdGenerator: undefined` → `sessionIdGenerator: () => randomUUID()`; add `Map<string, McpServer>` session store; handle `DELETE /mcp` for session cleanup

**Acceptance criteria:**
- `POST /mcp` with same session ID routes to same McpServer instance
- `DELETE /mcp` cleans up session
- Stateless clients (no session ID) still work (new instance per request)

**Doc updates (in-scope):**
- `ARCHITECTURE.md`: update MCP stateful session note in Phase 2a description
- `docs/adr/010-mcp-server.md`: update Decision Update section with implementation note

---

## Dependency Graph

```
Critical path to Phase 5:
B → H → I → J → K → Q → S
                         └→ R
                         └→ T (also needs F)
                         └→ U

Phase 2c (independent):
D → E → F → [T]

Phase 4 (independent):
L → M → O → P
L → N → O

Independent any time:
A, C, G, V, X
```

---

## Actions on Existing Issues

| Issue | Action |
|-------|--------|
| #20 (Phase 2c meta) | Close with comment: "Decomposed into Phase 2c-i (Issue D), 2c-ii (Issue E), 2c-iii (Issue F)" |
| #13 (ADR-011 docs) | Leave open; add comment linking to Phase 6 (deferred) |

---

## Labels to Create

| Label | Color | Usage |
|-------|-------|-------|
| `phase:1c` | grey | Phase 1c issues |
| `phase:2b` | blue | Phase 2b issues |
| `phase:2c` | blue | Phase 2c issues |
| `phase:3` | orange | Phase 3 issues |
| `phase:4` | green | Phase 4 issues |
| `phase:5` | purple | Phase 5 issues |
| `security` | red | Already exists |

---

## Issue Body Template

```markdown
## Context
<why this exists, what problem it solves>

## Scope

**Create:**
- `src/...`

**Modify:**
- `src/...`

## Acceptance criteria
- [ ] ...

## Test plan
\`\`\`bash
pnpm test
pnpm test:integration
\`\`\`
Verify: ...

## Doc updates (in-scope)
- `README.md`: ...
- `ARCHITECTURE.md`: ... (if applicable)
- `openapi.yaml`: ... (if applicable)
- `docs/adr/NNN-...md`: ... (if applicable)

## Blocked by
#NN (or "nothing")
```
