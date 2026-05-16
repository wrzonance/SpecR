# GitHub Issue Roadmap Creation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create 6 milestones, 6 labels, close issue #20, and create 24 GitHub issues per the approved roadmap design at `docs/superpowers/specs/2026-05-15-github-issue-roadmap-design.md`.

**Architecture:** Sequential `gh` CLI commands from the repo root. Issue bodies written to `/tmp/specr-issue-*.md` before creation to handle multi-line content and code blocks cleanly. Issue numbers predicted starting at #27 (verified in Task 1). Phase 5 issues created before Phase 4 issues to reflect priority ordering.

**Tech Stack:** `gh` CLI, GitHub API

---

## Pre-flight: Issue number mapping

Issue and PR numbers share one sequence in GitHub. Current max: #26. Predicted assignments:

| Letter | # | Phase | Title (short) |
|--------|---|-------|---------------|
| A | 27 | 1c | DOCX cross-ref extraction |
| B | 28 | 2b | content controls |
| C | 29 | 2b | MCP get_paragraph + parse_document |
| D | 30 | 2c | style_templates DB migrations |
| E | 31 | 2c | template CRUD API |
| F | 32 | 2c | wire templateId through generator |
| G | 33 | security | piscina concurrency cap |
| H | 34 | 3 | merge core |
| I | 35 | 3 | POST /specs/:id/diff |
| J | 36 | 3 | POST /specs/:id/merge |
| K | 37 | 3 | e2e round-trip test |
| Q | 38 | 5 | UI scaffold |
| R | 39 | 5 | spec tree viewer |
| S | 40 | 5 | diff/merge UI |
| T | 41 | 5 | template UI |
| U | 42 | 5 | library management |
| V | 43 | 5 | auth + multi-tenant |
| W | 44 | 5 | MCP write tools |
| X | 45 | 5 | MCP stateful sessions |
| L | 46 | 4 | Revit schema |
| M | 47 | 4 | PATCH /paragraphs/:nodeId |
| N | 48 | 4 | Revit add-in scaffold |
| O | 49 | 4 | Part 2 auto-populate |
| P | 50 | 4 | change detection |

If Task 1 reveals a different starting number, adjust all "Blocked by #NN" references before running Task 5+.

---

### Task 1: Verify repo state and predicted issue numbers

**Files:** none

- [ ] **Step 1: Verify next issue number**

```bash
cd /home/adam/github/SpecR
gh issue list --state all --limit 1 --json number | jq '.[0].number'
```

Expected: `26`

If different, note the delta and add it to every predicted number in the Pre-flight table before continuing.

- [ ] **Step 2: Verify gh CLI repo target**

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

Expected: `wrzonance/SpecR` (or your fork)

---

### Task 2: Create labels

**Files:** none

- [ ] **Step 1: Create phase labels**

```bash
gh label create "phase:1c" --color "C5C5C5" --description "Phase 1c issues" --force
gh label create "phase:2b" --color "0075CA" --description "Phase 2b issues" --force
gh label create "phase:2c" --color "0075CA" --description "Phase 2c issues" --force
gh label create "phase:3"  --color "E4E669" --description "Phase 3 issues" --force
gh label create "phase:4"  --color "0E8A16" --description "Phase 4 issues" --force
gh label create "phase:5"  --color "D93F0B" --description "Phase 5 issues" --force
```

`--force` is a no-op if the label already exists; safe to re-run.

- [ ] **Step 2: Verify**

```bash
gh label list | grep "phase:"
```

Expected: 6 lines.

---

### Task 3: Create milestones

**Files:** none

- [ ] **Step 1: Create milestones in priority order**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

gh api repos/$REPO/milestones --method POST \
  -f title="Phase 1c" \
  -f description="DOCX parser completion — 1c-iii cross-reference extraction"

gh api repos/$REPO/milestones --method POST \
  -f title="Phase 2b" \
  -f description="Core DOCX generator — content controls, MCP tools"

gh api repos/$REPO/milestones --method POST \
  -f title="Phase 2c" \
  -f description="Firm style template engine"

gh api repos/$REPO/milestones --method POST \
  -f title="Phase 3" \
  -f description="Round-trip merge engine"

gh api repos/$REPO/milestones --method POST \
  -f title="Phase 5" \
  -f description="Web UI — browser editor is primary surface"

gh api repos/$REPO/milestones --method POST \
  -f title="Phase 4" \
  -f description="Revit integration — standalone, lowest priority"
```

- [ ] **Step 2: Verify**

```bash
gh api repos/$REPO/milestones | jq '.[].title'
```

Expected: 6 milestone titles.

---

### Task 4: Close issue #20 with decomposition note

**Files:** none

- [ ] **Step 1: Post decomposition comment**

```bash
gh issue comment 20 --body "Closing in favour of decomposed sub-MVP issues per the Phase 2c roadmap:

- **Phase 2c-i** (#30) — \`style_templates\` + \`style_rules\` DB migrations + default CSI seed
- **Phase 2c-ii** (#31) — Template CRUD API (\`POST /templates\`, \`POST /templates/:id/rules\`)
- **Phase 2c-iii** (#32) — Wire \`templateId\` through generator

Each issue = one PR. See design doc: \`docs/superpowers/specs/2026-05-15-github-issue-roadmap-design.md\`"
```

- [ ] **Step 2: Close #20**

```bash
gh issue close 20
```

- [ ] **Step 3: Verify**

```bash
gh issue view 20 --json state -q .state
```

Expected: `CLOSED`

---

### Task 5: Create Phase 1c issue (A = #27)

**Files:** `/tmp/specr-issue-a.md`

- [ ] **Step 1: Write body**

```bash
cat > /tmp/specr-issue-a.md << 'EOF'
## Context

The `.SEC` parser extracts cross-references into `spec_references` at parse time. The DOCX parser does not. Parity required before DOCX-sourced specs can participate in broken-reference detection (`GET /projects/:id/references/broken`).

## Scope

**Create:** nothing new

**Modify:**
- `src/parser/docx/index.ts` — after hierarchy inference, run `SECTION_REF_RULES` regex over paragraph text; insert rows into `spec_references`
- `tests/integration/parse.integration.test.ts` — add fixture DOCX with known cross-refs; assert `spec_references` rows

## Acceptance criteria

- [ ] Parse DOCX with "See Section 09 91 00" → `spec_references` row with `target_spec_section = '09 91 00'`
- [ ] Parse DOCX with `ASTM C150` → `spec_references` row with `standard_code = 'ASTM C150'`
- [ ] No regression in existing parse integration tests

## Test plan

```bash
pnpm test:integration
```

Verify `spec_references` rows created for fixture DOCX.

## Doc updates (in-scope)

- `README.md`: update "What Works Today" → Parsing section; add DOCX cross-ref extraction
- `openapi.yaml`: no changes (no new endpoints)

## Blocked by

Nothing
EOF
```

- [ ] **Step 2: Create issue**

```bash
gh issue create \
  --title "feat(parser): Phase 1c-iii — DOCX cross-reference extraction" \
  --body-file /tmp/specr-issue-a.md \
  --label "phase:1c" \
  --milestone "Phase 1c"
```

Expected output: URL ending in `/issues/27`

- [ ] **Step 3: Verify**

```bash
gh issue view 27 --json number,title,milestone,labels \
  -q '{number, title, milestone: .milestone.title, labels: [.labels[].name]}'
```

---

### Task 6: Create Phase 2b issues (B = #28, C = #29)

**Files:** `/tmp/specr-issue-b.md`, `/tmp/specr-issue-c.md`

- [ ] **Step 1: Write Issue B body**

```bash
cat > /tmp/specr-issue-b.md << 'EOF'
## Context

The 3-way merge engine (Phase 3) needs stable paragraph identifiers that survive round-trips through Word/LibreOffice/Google Docs. ADR-004 specifies OOXML content controls (`w:sdt`) with a custom `specr-uuid-<id>` tag as the anchor. Phase 2b-i generates valid DOCX with CSI numbering but does not inject content controls. This issue adds the missing piece.

## Scope

**Create:**
- `src/generator/controls.ts` — `wrapWithControl(paragraph: Paragraph, uuid: string): XmlComponent` wrapping a dolanmiu/docx `Paragraph` in `w:sdt` with `<w:tag w:val="specr-uuid-{uuid}"/>`, `<w:alias w:val="SpecR paragraph"/>`, `<w:lock w:val="sdtContentLocked"/>`
- `src/generator/controls.test.ts` — unit tests: verify `w:sdt` XML structure in emitted buffer

**Modify:**
- `src/generator/index.ts` — call `wrapWithControl(para, node.id)` for each emitted paragraph before adding to `children[]`
- `tests/integration/generate.integration.test.ts` — generate DOCX, unzip buffer, parse `word/document.xml`, assert `w:sdt` elements present with correct `w:tag` values matching `CsiNode.id`

## Acceptance criteria

- [ ] Generate DOCX from any spec → unzip → every `<w:p>` wrapped in `<w:sdt><w:sdtPr><w:tag w:val="specr-uuid-..."/></w:sdtPr><w:sdtContent>...</w:sdtContent></w:sdt>`
- [ ] `w:tag` value matches `CsiNode.id` for each paragraph
- [ ] Open in Word: each paragraph shows content control boundary; tag visible in Developer tab
- [ ] No regression in existing generator tests

## Test plan

```bash
pnpm test                # unit: controls.test.ts
pnpm test:integration    # integration: generate.integration.test.ts
```

## Doc updates (in-scope)

- `README.md`: move "AST → DOCX generator + content controls" from "Not Yet Built" to "What Works Today"
- `ARCHITECTURE.md`: update Phase 2b status; note content controls complete
- `docs/adr/004-content-controls-as-merge-anchors.md`: update Status to "Implemented Phase 2b-ii"

## Blocked by

Nothing
EOF
```

- [ ] **Step 2: Create Issue B**

```bash
gh issue create \
  --title "feat(generator): Phase 2b-ii — w:sdt content control UUID injection" \
  --body-file /tmp/specr-issue-b.md \
  --label "phase:2b" \
  --milestone "Phase 2b"
```

Expected: `/issues/28`

- [ ] **Step 3: Write Issue C body**

```bash
cat > /tmp/specr-issue-c.md << 'EOF'
## Context

ADR-010 specifies `get_paragraph` and `parse_document` as Phase 2b MCP tools. `get_paragraph` gives AI agents per-paragraph context with ancestor chain. `parse_document` lets AI agents upload and parse specs without the REST multipart API.

## Scope

**Modify:**
- `src/mcp/tools.ts` — add two tools:
  - `get_paragraph(paragraph_id: string)` → `{ node: CsiNode, ancestors: CsiNode[] }` — query paragraph by UUID, reconstruct ancestor chain via `parent_id` chain in DB
  - `parse_document(filename: string, content_base64: string)` → `{ spec_id, section, title, node_count }` — base64-decode, detect format (`.docx`/`.sec`), call parser, return summary
- `src/mcp/tools.test.ts` — integration tests for both tools via `POST /mcp` JSON-RPC

## Acceptance criteria

- [ ] `get_paragraph` with valid UUID returns node + full ancestor chain
- [ ] `get_paragraph` with unknown UUID returns `isError: true`
- [ ] `parse_document` with base64-encoded UFGS `.SEC` returns spec summary
- [ ] `parse_document` with invalid base64 returns `isError: true`

## Test plan

```bash
pnpm test:integration
```

## Doc updates (in-scope)

- `README.md`: remove `get_paragraph` + `parse_document` from "Not Yet Built"
- `ARCHITECTURE.md`: update MCP tools list

## Blocked by

Nothing
EOF
```

- [ ] **Step 4: Create Issue C**

```bash
gh issue create \
  --title "feat(mcp): Phase 2b-iii — MCP get_paragraph + parse_document tools" \
  --body-file /tmp/specr-issue-c.md \
  --label "phase:2b" \
  --milestone "Phase 2b"
```

Expected: `/issues/29`

- [ ] **Step 5: Verify Phase 2b**

```bash
gh issue list --milestone "Phase 2b" --json number,title -q '.[] | "\(.number): \(.title)"'
```

Expected: `28` and `29`.

---

### Task 7: Create Phase 2c issues (D = #30, E = #31, F = #32)

**Files:** `/tmp/specr-issue-d.md`, `/tmp/specr-issue-e.md`, `/tmp/specr-issue-f.md`

- [ ] **Step 1: Write Issue D body**

```bash
cat > /tmp/specr-issue-d.md << 'EOF'
## Context

Generator uses hardcoded CSI default styles. This issue creates the DB schema for per-firm style templates. Subsequent issues add the CRUD API (#31) and generator wiring (#32).

## Scope

**Create:**
- `src/db/migrations/NNNN_style_templates.sql`:
  ```sql
  CREATE TABLE style_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    owner TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE style_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID REFERENCES style_templates(id) ON DELETE CASCADE,
    node_type VARCHAR(20) NOT NULL,
    font_family TEXT,
    font_size_pt NUMERIC,
    bold BOOLEAN,
    indent_twips INTEGER,
    space_before_pt NUMERIC,
    space_after_pt NUMERIC,
    numbering_format TEXT
  );
  ```
- `src/db/migrations/NNNN_style_templates.down.sql` — `DROP TABLE style_rules; DROP TABLE style_templates;`
- `src/db/migrations/NNNN_seed_default_csi_styles.sql` — default template row + one `style_rules` row per NodeType (part, article, pr1–pr5) matching current hardcoded generator values
- `src/db/queries/templates.ts` — `getTemplate(id)`, `listTemplates()`, `createTemplate(name, owner?)`, `upsertStyleRule(templateId, nodeType, rules)`

**Modify:**
- `src/db/index.ts` — re-export all functions from `templates.ts`

## Acceptance criteria

- [ ] `pnpm migrate` succeeds; `pnpm migrate:down` reverses cleanly
- [ ] Default template seed row present with 7 node_type rules (part, article, pr1–pr5)
- [ ] `getTemplate(id)` returns the seeded default template with rules array
- [ ] `listTemplates()` returns all templates

## Test plan

```bash
pnpm migrate
pnpm test:integration
```

Verify default template and rules exist after migration.

## Doc updates (in-scope)

- `ARCHITECTURE.md`: add `style_templates` + `style_rules` schema to Database Schema section
- `openapi.yaml`: no endpoint changes yet

## Blocked by

Nothing
EOF
```

- [ ] **Step 2: Create Issue D**

```bash
gh issue create \
  --title "feat(db): Phase 2c-i — style_templates + style_rules migrations + default CSI seed" \
  --body-file /tmp/specr-issue-d.md \
  --label "phase:2c" \
  --milestone "Phase 2c"
```

Expected: `/issues/30`

- [ ] **Step 3: Write Issue E body**

```bash
cat > /tmp/specr-issue-e.md << 'EOF'
## Context

Firms need to create and configure style templates via API before the generator can apply them. Depends on DB schema from #30. Template import from `.dotx` files is deferred.

## Scope

**Create:**
- `src/api/templates.ts` — handlers: `createTemplateHandler`, `listTemplatesHandler`, `getTemplateHandler`, `upsertStyleRuleHandler`
- `tests/integration/templates.integration.test.ts`

**Modify:**
- `src/api/router.ts` — add: `POST /templates`, `GET /templates`, `GET /templates/:id`, `POST /templates/:id/rules`
- `src/ast/schemas.ts` — add `CreateTemplateBodySchema`, `UpsertStyleRuleBodySchema` (Zod)
- `openapi.yaml` — document all four endpoints

## Acceptance criteria

- [ ] `POST /templates` creates template, returns `{ success: true, data: { id, name } }`
- [ ] `POST /templates/:id/rules` upserts rule for given `node_type`
- [ ] `GET /templates/:id` returns template with all rules
- [ ] `GET /templates` returns all templates
- [ ] Unknown template ID → 404

## Test plan

```bash
pnpm test:integration
```

## Doc updates (in-scope)

- `README.md`: add template endpoints to API table
- `openapi.yaml`: all four endpoints + request/response schemas

## Blocked by

#30
EOF
```

- [ ] **Step 4: Create Issue E**

```bash
gh issue create \
  --title "feat(api): Phase 2c-ii — template CRUD API" \
  --body-file /tmp/specr-issue-e.md \
  --label "phase:2c" \
  --milestone "Phase 2c"
```

Expected: `/issues/31`

- [ ] **Step 5: Write Issue F body**

```bash
cat > /tmp/specr-issue-f.md << 'EOF'
## Context

`POST /specs/:id/generate` already accepts `{ templateId? }` in the request body (per ARCHITECTURE.md) but ignores it. This issue loads the template from DB and applies its rules to font, spacing, indent, and numbering format in the generated DOCX. Depends on DB schema (#30) and CRUD API (#31).

## Scope

**Modify:**
- `src/api/generate.ts` — parse `templateId?` from request body; pass to `generateDocx`
- `src/generator/index.ts` — accept optional `StyleTemplate` arg; apply font/spacing rules per paragraph
- `src/generator/numbering.ts` — accept optional numbering format overrides from template rules
- `src/ast/schemas.ts` — add `GenerateBodySchema` with `templateId: z.string().uuid().optional()`
- `tests/integration/generate.integration.test.ts` — add: generate with explicit templateId; generate with unknown templateId → 404

## Acceptance criteria

- [ ] `POST /specs/:id/generate` with default template ID → identical output to no-template request
- [ ] Custom template with modified font/spacing → DOCX applies those values
- [ ] Unknown `templateId` → 404
- [ ] No regression on existing generate tests

## Test plan

```bash
pnpm test:integration
```

## Doc updates (in-scope)

- `README.md`: update Phase 2c status to "Complete ✅"
- `openapi.yaml`: document `templateId` in generate request body schema

## Blocked by

#30, #31
EOF
```

- [ ] **Step 6: Create Issue F**

```bash
gh issue create \
  --title "feat(generator): Phase 2c-iii — wire templateId through generator" \
  --body-file /tmp/specr-issue-f.md \
  --label "phase:2c" \
  --milestone "Phase 2c"
```

Expected: `/issues/32`

- [ ] **Step 7: Verify Phase 2c**

```bash
gh issue list --milestone "Phase 2c" --json number,title -q '.[] | "\(.number): \(.title)"'
```

Expected: `30`, `31`, `32`.

---

### Task 8: Create security issue (G = #33)

**Files:** `/tmp/specr-issue-g.md`

- [ ] **Step 1: Write body**

```bash
cat > /tmp/specr-issue-g.md << 'EOF'
## Context

PR #23 added rate limiting and yauzl validation. Remaining gap: unbounded concurrent parse workers. Large DOCX files under concurrent load can exhaust Node.js memory. piscina provides a worker thread pool with a configurable cap.

## Scope

**Create:**
- `src/lib/parse-worker.ts` — worker module that calls `parse(input)` and returns result; must be a plain JS file (no top-level await issues in piscina workers)
- `src/lib/parse-pool.ts`:
  ```typescript
  import Piscina from 'piscina';
  import os from 'os';
  export const parsePool = new Piscina({
    filename: new URL('./parse-worker.js', import.meta.url).href,
    maxThreads: Math.max(1, os.cpus().length - 1),
  });
  ```

**Modify:**
- `src/api/parse.ts` — replace direct `parse()` call with `parsePool.run(input)`
- `package.json` — add `piscina` to `dependencies`

## Acceptance criteria

- [ ] Concurrent parse requests capped at `cpu_count - 1` workers
- [ ] Single parse request completes correctly end-to-end
- [ ] Requests beyond pool capacity queue (piscina default behaviour), not rejected
- [ ] All existing parse integration tests pass

## Test plan

```bash
pnpm test:integration
```

## Doc updates (in-scope)

- `README.md`: remove piscina concurrency cap from "Not Yet Built"

## Blocked by

Nothing
EOF
```

- [ ] **Step 2: Create issue** (no milestone — standalone security)

```bash
gh issue create \
  --title "chore(security): parse worker concurrency cap — piscina, follow-up to #23" \
  --body-file /tmp/specr-issue-g.md \
  --label "security"
```

Expected: `/issues/33`

---

### Task 9: Create Phase 3 issues (H = #34, I = #35, J = #36, K = #37)

**Files:** `/tmp/specr-issue-h.md` through `/tmp/specr-issue-k.md`

- [ ] **Step 1: Write Issue H body**

```bash
cat > /tmp/specr-issue-h.md << 'EOF'
## Context

ADR-005 specifies a git-style 3-way merge: base_version (DB snapshot) + theirs (returned DOCX) + ours (current DB). This issue implements the pure algorithm and DOCX UUID extraction utility. No HTTP endpoints yet. Depends on content controls (#28) for integration tests (generated DOCX must contain `w:sdt` tags to test extraction).

## Scope

**Create:**
- `src/merge/error.ts`:
  ```typescript
  import { SpecrError } from '../lib/errors.js';
  export class MergeError extends SpecrError {}
  ```
- `src/merge/types.ts`:
  ```typescript
  export interface ParagraphDiff { uuid: string; text: string }
  export interface ModifiedDiff { uuid: string; base: string; theirs: string; ours: string }
  export interface ConflictDiff { uuid: string; base: string; theirs: string; ours: string }
  export interface DiffResult {
    added: ParagraphDiff[];
    modified: ModifiedDiff[];
    deleted: string[];
    conflicts: ConflictDiff[];
  }
  export interface ParagraphSnapshot { uuid: string; text: string; baseVersion: number }
  ```
- `src/merge/extract.ts` — `extractContentControls(docxBuffer: Buffer): Promise<Map<string, string>>` — unzip buffer via JSZip, parse `word/document.xml`, return `Map<uuid, plainText>` from all `w:sdt` where `w:tag/@w:val` starts with `specr-uuid-`
- `src/merge/diff.ts` — `computeDiff(base: ParagraphSnapshot[], ours: ParagraphSnapshot[], theirs: Map<string, string>): DiffResult`
- `src/merge/index.ts` — re-export: `MergeError`, `computeDiff`, `extractContentControls`, all types
- `src/merge/diff.test.ts` — unit tests: known base/theirs/ours inputs → expected `DiffResult`
- `src/merge/extract.test.ts` — generate DOCX via `generateDocx`, call `extractContentControls`, verify UUID map

**Modify:**
- `src/db/queries/versions.ts` — ensure `getParagraphSnapshots(specId: string): Promise<ParagraphSnapshot[]>` exists; add if missing

## Acceptance criteria

- [ ] `computeDiff`: theirs-only text change → entry in `modified` with `ours === base`
- [ ] `computeDiff`: both sides changed → entry in `conflicts`
- [ ] `computeDiff`: UUID in base but not in theirs → UUID in `deleted`
- [ ] `computeDiff`: paragraph in theirs with no matching UUID → entry in `added`
- [ ] `extractContentControls` returns correct UUID→text map from a SpecR-generated DOCX buffer
- [ ] No HTTP dependency; fully unit-testable

## Test plan

```bash
pnpm test    # diff.test.ts, extract.test.ts
```

## Doc updates (in-scope)

- `ARCHITECTURE.md`: add `src/merge/` to project file structure
- `docs/adr/005-git-style-3-way-merge.md`: update Status to "In progress — Phase 3a"

## Blocked by

#28
EOF
```

- [ ] **Step 2: Create Issue H**

```bash
gh issue create \
  --title "feat(merge): Phase 3a — merge module core (UUID match + 3-way diff)" \
  --body-file /tmp/specr-issue-h.md \
  --label "phase:3" \
  --milestone "Phase 3"
```

Expected: `/issues/34`

- [ ] **Step 3: Write Issue I body**

```bash
cat > /tmp/specr-issue-i.md << 'EOF'
## Context

First Phase 3 HTTP endpoint. Client uploads an edited DOCX; endpoint parses it, extracts content control UUIDs, runs 3-way diff against DB state, returns structured diff. Also adds `get_spec_diff` MCP tool and `specr://specs/{id}/diff` resource for AI-assisted merge review.

## Scope

**Create:**
- `src/api/diff.ts` — `diffHandler`: validate spec ID, receive multipart DOCX via multer, call `extractContentControls` + `computeDiff`, return `ApiResponse<DiffResult>`
- `tests/integration/diff.integration.test.ts`

**Modify:**
- `src/api/router.ts` — add `POST /specs/:id/diff` (with `upload.single('file')` multer middleware)
- `src/mcp/tools.ts` — add `get_spec_diff(spec_id: string)` tool → same diff logic, returns `DiffResult`
- `src/mcp/resources.ts` — add `specr://specs/{id}/diff` resource → `DiffResult` as JSON string
- `openapi.yaml` — document endpoint + `DiffResult` schema

## Acceptance criteria

- [ ] Upload unmodified SpecR-generated DOCX → `{ added: [], modified: [], deleted: [], conflicts: [] }`
- [ ] Upload DOCX with one paragraph text changed → `modified` contains that paragraph with base/theirs/ours
- [ ] Upload DOCX with one paragraph deleted → `deleted` contains that UUID
- [ ] Upload non-DOCX → 422
- [ ] MCP `get_spec_diff` returns same shape as REST endpoint

## Test plan

```bash
pnpm test:integration    # diff.integration.test.ts
```

## Doc updates (in-scope)

- `README.md`: add `POST /specs/:id/diff` to API table
- `openapi.yaml`: endpoint + `DiffResult` schema

## Blocked by

#34
EOF
```

- [ ] **Step 4: Create Issue I**

```bash
gh issue create \
  --title "feat(api): Phase 3b — POST /specs/:id/diff + MCP get_spec_diff + specr://diff resource" \
  --body-file /tmp/specr-issue-i.md \
  --label "phase:3" \
  --milestone "Phase 3"
```

Expected: `/issues/35`

- [ ] **Step 5: Write Issue J body**

```bash
cat > /tmp/specr-issue-j.md << 'EOF'
## Context

Second Phase 3 endpoint. Client submits accepted change UUIDs; endpoint applies them to `paragraphs` rows, bumps `base_version`, inserts version snapshots. Rejected changes are discarded. Phase 5 UI scaffold (#38) can start after this issue merges without waiting for the e2e test (#37).

## Scope

**Create:**
- `src/merge/conflict.ts` — `applyAccepted(specId: string, acceptedIds: string[], diff: DiffResult, client: PoolClient): Promise<{ applied: number; rejected: number }>` — updates `paragraphs.text`, inserts snapshot into `paragraph_versions`, increments `base_version`
- `src/api/merge.ts` — `mergeHandler`: validate spec ID + body `{ accept: string[] }`, call `applyAccepted`, return `{ success: true, data: { applied, rejected } }`
- `tests/integration/merge.integration.test.ts`

**Modify:**
- `src/api/router.ts` — add `POST /specs/:id/merge`
- `openapi.yaml` — document endpoint

## Acceptance criteria

- [ ] Accept one UUID → `paragraphs.text` updated, `base_version` incremented, `paragraph_versions` snapshot inserted
- [ ] Reject all (empty `accept` array) → `{ applied: 0, rejected: N }`, no DB change
- [ ] Unknown UUID in `accept` list → 400 with descriptive error message
- [ ] Idempotent: applying same UUID twice is a no-op on second call

## Test plan

```bash
pnpm test:integration    # merge.integration.test.ts
```

## Doc updates (in-scope)

- `README.md`: add `POST /specs/:id/merge` to API table
- `docs/adr/005-git-style-3-way-merge.md`: update Status to "Implemented Phase 3c"
- `openapi.yaml`: merge endpoint + request/response schema

## Blocked by

#35
EOF
```

- [ ] **Step 6: Create Issue J**

```bash
gh issue create \
  --title "feat(api): Phase 3c — POST /specs/:id/merge + base_version tracking" \
  --body-file /tmp/specr-issue-j.md \
  --label "phase:3" \
  --milestone "Phase 3"
```

Expected: `/issues/36`

- [ ] **Step 7: Write Issue K body**

```bash
cat > /tmp/specr-issue-k.md << 'EOF'
## Context

Phase 3 acceptance test. Proves the full round-trip value proposition end-to-end. Phase 5 UI scaffold (#38) does NOT need to wait for this issue — it can start after #36 (merge API). This test is the Phase 3 milestone completion marker.

## Scope

**Create:**
- `tests/integration/roundtrip.integration.test.ts` — full scenario:
  1. Parse UFGS `.SEC` fixture → `spec_id`
  2. `POST /specs/:id/generate` → DOCX buffer
  3. Mutate buffer: JSZip unzip, change one `<w:t>` text node, rezip
  4. `POST /specs/:id/diff` with mutated buffer → assert `modified` contains changed paragraph UUID
  5. `POST /specs/:id/merge` with `{ accept: [changedUUID] }` → assert `{ applied: 1 }`
  6. `GET /specs/:id` → assert paragraph text updated in DB

## Acceptance criteria

- [ ] Full scenario passes end-to-end
- [ ] Test is deterministic (UFGS fixture, no random data)
- [ ] Comment in test documents which applications' content control survival is assumed

## Test plan

```bash
pnpm test:integration    # roundtrip.integration.test.ts
```

## Doc updates (in-scope)

- `README.md`: update Phase 3 row to "Complete ✅"; move merge engine from "Not Yet Built"
- `ARCHITECTURE.md`: update Phase 3 completion
- `docs/adr/004-content-controls-as-merge-anchors.md`: add note listing tested applications

## Blocked by

#36
EOF
```

- [ ] **Step 8: Create Issue K**

```bash
gh issue create \
  --title "test: Phase 3d — end-to-end round-trip integration test" \
  --body-file /tmp/specr-issue-k.md \
  --label "phase:3" \
  --milestone "Phase 3"
```

Expected: `/issues/37`

- [ ] **Step 9: Verify Phase 3**

```bash
gh issue list --milestone "Phase 3" --json number,title -q '.[] | "\(.number): \(.title)"'
```

Expected: `34`, `35`, `36`, `37`.

---

### Task 10: Create Phase 5 issues (Q = #38 through X = #45)

**Files:** `/tmp/specr-issue-q.md` through `/tmp/specr-issue-x.md`

- [ ] **Step 1: Write Issue Q body**

```bash
cat > /tmp/specr-issue-q.md << 'EOF'
## Context

First Phase 5 issue. Establishes the frontend project structure within the monorepo. React + TypeScript + Vite. Typed API client derived from `openapi.yaml` via `openapi-typescript` + `openapi-fetch` (no codegen step; types are derived at build time). No features yet — scaffold only. The browser editor is the primary user surface; Phase 4 Revit integration proceeds independently.

## Scope

**Create:**
- `ui/` — Vite React/TS scaffold:
  - `ui/src/api/client.ts` — typed fetch client using `openapi-fetch`; schema derived from `../../openapi.yaml` via `openapi-typescript`
  - `ui/src/App.tsx` — root with React Router
  - `ui/vite.config.ts` — proxies `/api` → `http://localhost:3000`
  - `ui/package.json` — workspace config

**Modify:**
- Root `package.json` — add `ui` to `workspaces`
- `docker-compose.yml` — add `ui` service for local dev (optional)

## Acceptance criteria

- [ ] `pnpm --filter ui dev` starts Vite dev server without errors
- [ ] `ui/src/api/client.ts` typechecks against `openapi.yaml`
- [ ] `GET /health` call from browser succeeds through proxy

## Test plan

```bash
pnpm --filter ui dev
# Open http://localhost:5173 — no errors in console
```

## Doc updates (in-scope)

- `README.md`: add "Web UI" development section

## Blocked by

#36
EOF
```

- [ ] **Step 2: Create Issue Q**

```bash
gh issue create \
  --title "feat(ui): Phase 5a — frontend scaffold (React/TS, Vite, openapi-fetch client)" \
  --body-file /tmp/specr-issue-q.md \
  --label "phase:5" \
  --milestone "Phase 5"
```

Expected: `/issues/38`

- [ ] **Step 3: Write Issue R body**

```bash
cat > /tmp/specr-issue-r.md << 'EOF'
## Context

First real UI feature. View a parsed spec as an interactive tree (Part → Article → PR1–PR5 hierarchy). Show parse job progress from `GET /parse/jobs/:jobId` polling.

## Scope

**Create:**
- `ui/src/pages/ParsePage.tsx` — file upload + progress bar polling `GET /parse/jobs/:jobId`
- `ui/src/pages/SpecPage.tsx` — renders `CsiTree` from `GET /specs/:id`
- `ui/src/components/CsiTreeView.tsx` — recursive collapsible tree node renderer

## Acceptance criteria

- [ ] Upload DOCX → progress bar fills → redirect to spec tree view
- [ ] Spec tree shows Part/Article/PR hierarchy with correct indentation
- [ ] Clicking a node expands/collapses children

## Test plan

Manual: upload an ARCAT fixture DOCX, verify tree renders correctly.

## Doc updates (in-scope)

- `README.md`: update Phase 5 description

## Blocked by

#38
EOF
```

- [ ] **Step 4: Create Issue R**

```bash
gh issue create \
  --title "feat(ui): Phase 5b — spec tree viewer + parse job progress UI" \
  --body-file /tmp/specr-issue-r.md \
  --label "phase:5" \
  --milestone "Phase 5"
```

Expected: `/issues/39`

- [ ] **Step 5: Write Issue S body**

```bash
cat > /tmp/specr-issue-s.md << 'EOF'
## Context

The spec writer's primary review workflow. Upload redlined DOCX, see diff results, accept or reject changes per paragraph. Depends on UI scaffold (#38) and merge API (#36).

## Scope

**Create:**
- `ui/src/pages/DiffPage.tsx` — upload returned DOCX, POST to `/specs/:id/diff`, render result
- `ui/src/components/ConflictCard.tsx` — side-by-side base | theirs | ours for each conflict with accept/reject radio
- `ui/src/components/DiffSummary.tsx` — added/modified/deleted/conflicts counts

## Acceptance criteria

- [ ] Upload DOCX → diff results rendered with counts
- [ ] Each conflict shows three versions; user selects which to accept
- [ ] Submit → `POST /specs/:id/merge` called with accepted UUIDs
- [ ] Confirmation screen shows `{ applied, rejected }` counts

## Test plan

Manual: generate DOCX, edit one paragraph in Word, upload, verify diff UI shows the change, accept it, verify DB updated.

## Doc updates (in-scope)

- `README.md`: update Phase 5 description

## Blocked by

#38, #36
EOF
```

- [ ] **Step 6: Create Issue S**

```bash
gh issue create \
  --title "feat(ui): Phase 5c — diff/merge review interface (3-way conflict resolution)" \
  --body-file /tmp/specr-issue-s.md \
  --label "phase:5" \
  --milestone "Phase 5"
```

Expected: `/issues/40`

- [ ] **Step 7: Write Issue T body**

```bash
cat > /tmp/specr-issue-t.md << 'EOF'
## Context

Firms configure their house style through the UI. Create templates, set per-node-type rules. Preview a generated DOCX with the new template before saving. Depends on UI scaffold (#38) and template generator wiring (#32).

## Scope

**Create:**
- `ui/src/pages/TemplatesPage.tsx` — list templates, create new via `POST /templates`
- `ui/src/pages/TemplateEditorPage.tsx` — per-node-type rule editor table; download preview DOCX via `POST /specs/:id/generate` with `{ templateId }`

## Acceptance criteria

- [ ] Create template → appears in list
- [ ] Edit rule → generate preview DOCX download link appears

## Test plan

Manual: create a template, change PR1 font size, generate preview, verify change in Word.

## Doc updates (in-scope)

- `README.md`: update Phase 5 description

## Blocked by

#38, #32
EOF
```

- [ ] **Step 8: Create Issue T**

```bash
gh issue create \
  --title "feat(ui): Phase 5d — style template configuration UI" \
  --body-file /tmp/specr-issue-t.md \
  --label "phase:5" \
  --milestone "Phase 5"
```

Expected: `/issues/41`

- [ ] **Step 9: Write Issue U body**

```bash
cat > /tmp/specr-issue-u.md << 'EOF'
## Context

Browse and manage the paragraph library. Search across specs, view broken cross-references, manage project TOCs.

## Scope

**Create:**
- `ui/src/pages/LibraryPage.tsx` — search interface calling `search_library` MCP tool or REST search endpoint
- `ui/src/pages/ProjectPage.tsx` — TOC management: add/remove/reorder specs
- `ui/src/pages/BrokenRefsPage.tsx` — list broken refs from `GET /projects/:id/references/broken`

## Acceptance criteria

- [ ] Search input returns paragraph results from library
- [ ] Project TOC shows spec list with add/remove controls
- [ ] Broken refs page lists unresolved cross-references

## Test plan

Manual: search for "seismic", verify results. Add a spec to a project, verify it appears in TOC.

## Doc updates (in-scope)

- `README.md`: update Phase 5 description

## Blocked by

#38
EOF
```

- [ ] **Step 10: Create Issue U**

```bash
gh issue create \
  --title "feat(ui): Phase 5e — firm library management" \
  --body-file /tmp/specr-issue-u.md \
  --label "phase:5" \
  --milestone "Phase 5"
```

Expected: `/issues/42`

- [ ] **Step 11: Write Issue V body**

```bash
cat > /tmp/specr-issue-v.md << 'EOF'
## Context

Multi-firm SaaS requires authentication and org-level data isolation. JWT-based auth for REST API and MCP. ADR-010 marks the auth insertion point in `src/mcp/server.ts` at lines 19–21. This is a prerequisite for MCP write tools (#44).

## Scope

**Create:**
- `src/lib/auth.ts` — `verifyJwt(token: string): { orgId: string; userId: string }` middleware; `requireAuth` Express middleware that sets `req.org`
- `src/db/migrations/NNNN_orgs_users.sql` — `orgs`, `users`, `org_memberships` tables

**Modify:**
- `src/mcp/server.ts` — fill auth hook at marked insertion point (lines 19–21): validate `Authorization: Bearer <token>` header
- All DB query functions — add `orgId` filter to all spec/project queries
- `src/api/router.ts` — apply `requireAuth` to all routes except `GET /health`
- `openapi.yaml` — add `BearerAuth` security scheme to all endpoints

## Acceptance criteria

- [ ] Unauthenticated request to `GET /specs/:id` → 401
- [ ] Token from org A cannot access specs belonging to org B → 403
- [ ] MCP request with invalid bearer token → `isError: true` response
- [ ] `GET /health` still returns 200 without auth

## Test plan

```bash
pnpm test:integration
```

Verify existing tests still pass (will need tokens added to test setup).

## Doc updates (in-scope)

- `README.md`: add authentication section
- `openapi.yaml`: `BearerAuth` security scheme applied to all endpoints

## Blocked by

Nothing
EOF
```

- [ ] **Step 12: Create Issue V**

```bash
gh issue create \
  --title "feat(api): Phase 5f — authentication + multi-tenant (JWT, org isolation)" \
  --body-file /tmp/specr-issue-v.md \
  --label "phase:5" \
  --milestone "Phase 5"
```

Expected: `/issues/43`

- [ ] **Step 13: Write Issue W body**

```bash
cat > /tmp/specr-issue-w.md << 'EOF'
## Context

ADR-010 lists write tools as Phase 5. Enables AI agents to author spec content via MCP without the REST API. Requires auth (#43) — write tools must reject unauthenticated callers.

## Scope

**Modify:**
- `src/mcp/tools.ts` — add three tools:
  - `add_paragraph(spec_id: string, parent_id: string, node_type: NodeType, text: string, position: number)` → `{ uuid: string }` — inserts new `paragraphs` row
  - `update_paragraph(paragraph_id: string, text: string)` → `{ node: CsiNode }` — updates text, bumps `base_version`
  - `delete_paragraph(paragraph_id: string)` → `{ deleted: string }` — removes row + children via CASCADE

## Acceptance criteria

- [ ] `add_paragraph` inserts row, returns UUID
- [ ] `update_paragraph` updates text, bumps `base_version`
- [ ] `delete_paragraph` removes row and all children
- [ ] All three return `isError: true` for unauthenticated callers

## Test plan

```bash
pnpm test:integration
```

## Doc updates (in-scope)

- `README.md`: remove MCP write tools from "Not Yet Built"

## Blocked by

#43
EOF
```

- [ ] **Step 14: Create Issue W**

```bash
gh issue create \
  --title "feat(mcp): Phase 5g — MCP write tools (add_paragraph, update_paragraph, delete_paragraph)" \
  --body-file /tmp/specr-issue-w.md \
  --label "phase:5" \
  --milestone "Phase 5"
```

Expected: `/issues/44`

- [ ] **Step 15: Write Issue X body**

```bash
cat > /tmp/specr-issue-x.md << 'EOF'
## Context

Current MCP transport is stateless (one `McpServer` per request). Phase 5 UI progress bars and streaming tool responses require persistent sessions. ADR-010 documents the upgrade as a one-parameter change + session Map in the route handler.

## Scope

**Modify:**
- `src/mcp/server.ts`:
  - Change `sessionIdGenerator: undefined` → `sessionIdGenerator: () => randomUUID()`
  - Add `const sessions = new Map<string, McpServer>()` in route handler scope
  - Reuse existing `McpServer` for requests with matching session ID header
  - Handle `DELETE /mcp` — call `server.close()` + `sessions.delete(sessionId)`

## Acceptance criteria

- [ ] `POST /mcp` with same `mcp-session-id` header routes to same `McpServer` instance
- [ ] `DELETE /mcp` cleans up session from Map
- [ ] Stateless clients (no session ID) still work — fresh instance per request
- [ ] No tool or resource definition changes required

## Test plan

```bash
pnpm test:integration
```

Verify existing MCP integration tests still pass.

## Doc updates (in-scope)

- `ARCHITECTURE.md`: update MCP stateful session note in Phase 2a description
- `docs/adr/010-mcp-server.md`: update Decision Update section with implementation note

## Blocked by

Nothing
EOF
```

- [ ] **Step 16: Create Issue X**

```bash
gh issue create \
  --title "feat(mcp): Phase 5h — MCP stateful sessions + streaming upgrade" \
  --body-file /tmp/specr-issue-x.md \
  --label "phase:5" \
  --milestone "Phase 5"
```

Expected: `/issues/45`

- [ ] **Step 17: Verify Phase 5**

```bash
gh issue list --milestone "Phase 5" --json number,title -q '.[] | "\(.number): \(.title)"'
```

Expected: `38`, `39`, `40`, `41`, `42`, `43`, `44`, `45` (8 issues).

---

### Task 11: Create Phase 4 issues (L = #46, M = #47, N = #48, O = #49, P = #50)

**Files:** `/tmp/specr-issue-l.md` through `/tmp/specr-issue-p.md`

- [ ] **Step 1: Write Issue L body**

```bash
cat > /tmp/specr-issue-l.md << 'EOF'
## Context

ADR-009 specifies a Revit parameter → CSI paragraph mapping schema. Each mapping binds a Revit parameter name (e.g. `Manufacturer`) to a paragraph UUID and a transform rule. This is the DB foundation for Phase 4; the Revit add-in (#48) and paragraph update API (#47) both depend on it.

**Phase 4 is standalone** — no Phase 5 dependency in either direction. Phase 4 can be worked in parallel with Phase 5 or deferred entirely.

## Scope

**Create:**
- `src/db/migrations/NNNN_revit_mappings.sql`:
  ```sql
  CREATE TABLE revit_parameter_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spec_id UUID REFERENCES specs(id) ON DELETE CASCADE,
    paragraph_id UUID REFERENCES paragraphs(id) ON DELETE CASCADE,
    revit_param TEXT NOT NULL,
    transform_type VARCHAR(20) NOT NULL,
    transform_config JSONB
  );
  ```
- `src/db/migrations/NNNN_revit_mappings.down.sql` — `DROP TABLE revit_parameter_mappings;`
- `src/db/queries/revit.ts` — `getMappings(specId: string)`, `upsertMapping(...)`, `deleteMapping(id: string)`

**Modify:**
- `src/db/index.ts` — re-export revit queries
- `src/ast/types.ts` — confirm `meta.revitParam?: string` is present (it is per ARCHITECTURE.md)

## Acceptance criteria

- [ ] `pnpm migrate` succeeds; `pnpm migrate:down` reverses cleanly
- [ ] `upsertMapping` is idempotent on `(spec_id, paragraph_id, revit_param)`
- [ ] `getMappings(specId)` returns all mappings for a spec

## Test plan

```bash
pnpm migrate
pnpm test:integration
```

## Doc updates (in-scope)

- `ARCHITECTURE.md`: document `revit_parameter_mappings` table schema

## Blocked by

Nothing (standalone Phase 4 — can start any time after Phase 3)
EOF
```

- [ ] **Step 2: Create Issue L**

```bash
gh issue create \
  --title "feat(db): Phase 4a — Revit parameter mapping schema + migrations" \
  --body-file /tmp/specr-issue-l.md \
  --label "phase:4" \
  --milestone "Phase 4"
```

Expected: `/issues/46`

- [ ] **Step 3: Write Issue M body**

```bash
cat > /tmp/specr-issue-m.md << 'EOF'
## Context

ADR-009 requires individual paragraph update via UUID — the Revit add-in (#48) calls this endpoint to push model parameter changes without replacing the whole spec.

## Scope

**Create:**
- `src/api/paragraphs.ts` — `updateParagraphHandler`: validate spec ID + node UUID, verify node belongs to spec, update `paragraphs.text` + `updated_at`, bump `base_version`, return updated node as `ApiResponse<CsiNode>`
- `tests/integration/paragraphs.integration.test.ts`

**Modify:**
- `src/api/router.ts` — add `PATCH /specs/:id/paragraphs/:nodeId`
- `openapi.yaml` — document endpoint

## Acceptance criteria

- [ ] PATCH with valid IDs + `{ text: "new text" }` → paragraph updated, `base_version` incremented
- [ ] PATCH with unknown `nodeId` → 404
- [ ] PATCH with `nodeId` belonging to a different spec → 403
- [ ] PATCH with empty `text` → 400

## Test plan

```bash
pnpm test:integration
```

## Doc updates (in-scope)

- `README.md`: add `PATCH /specs/:id/paragraphs/:nodeId` to API table
- `openapi.yaml`: endpoint + request/response schema

## Blocked by

#46
EOF
```

- [ ] **Step 4: Create Issue M**

```bash
gh issue create \
  --title "feat(api): Phase 4b — PATCH /specs/:id/paragraphs/:nodeId individual update endpoint" \
  --body-file /tmp/specr-issue-m.md \
  --label "phase:4" \
  --milestone "Phase 4"
```

Expected: `/issues/47`

- [ ] **Step 5: Write Issue N body**

```bash
cat > /tmp/specr-issue-n.md << 'EOF'
## Context

Separate C#/.NET project in `revit-addin/`. Revit add-in (`.addin` manifest + `IExternalApplication`) that connects to a running SpecR instance. REST client generated from `openapi.yaml` via NSwag or Refit. Phase 4c is the scaffold only — no data flow yet.

## Scope

**Create:**
- `revit-addin/` — new directory (separate C# solution):
  - `SpecRAddin.csproj` — targets Revit API version (2024+)
  - `App.cs` — `IExternalApplication` with ribbon button registration
  - `SpecRClient.cs` — typed REST client (Refit or NSwag from `openapi.yaml`)
  - `SpecRAddin.addin` — Revit manifest file

## Acceptance criteria

- [ ] Add-in loads in Revit without error
- [ ] Ribbon button appears in Revit UI
- [ ] `SpecRClient.GetSpec(id)` returns deserialized response from running SpecR dev server

## Test plan

Manual: load add-in in Revit 2024, verify ribbon button, call `GET /health` from add-in.

## Doc updates (in-scope)

- `README.md`: add "Revit Add-In" section with setup instructions
- `ARCHITECTURE.md`: update Phase 4 with add-in project location

## Blocked by

#46
EOF
```

- [ ] **Step 6: Create Issue N**

```bash
gh issue create \
  --title "feat(revit): Phase 4c — Revit add-in scaffold (C#/.NET + SpecR REST client)" \
  --body-file /tmp/specr-issue-n.md \
  --label "phase:4" \
  --milestone "Phase 4"
```

Expected: `/issues/48`

- [ ] **Step 7: Write Issue O body**

```bash
cat > /tmp/specr-issue-o.md << 'EOF'
## Context

Core Phase 4 value: Revit equipment family instances → Part 2 (Products) paragraph population. Reads Revit `FamilyInstance` parameters, maps via `revit_parameter_mappings`, pushes updates to `PATCH /specs/:id/paragraphs/:nodeId`. Shows WPF preview dialog before commit.

## Scope

**Modify:**
- `revit-addin/` — add `SyncCommand.cs`:
  - Reads selected Revit elements (`FamilyInstance.get_Parameter(...)`)
  - Fetches mappings via `GET /specs/:id/mappings`
  - Diffs current paragraph text vs. proposed Revit-derived text
  - Shows WPF preview dialog listing all proposed changes
  - On confirm: calls `PATCH /specs/:id/paragraphs/:nodeId` for each change
  - On cancel: no API calls made

## Acceptance criteria

- [ ] Select Revit equipment → sync command shows preview of paragraph changes
- [ ] Confirm → paragraphs updated in DB
- [ ] Cancel → no DB change
- [ ] Unknown Revit parameter (no mapping) → skipped, logged to Revit journal

## Test plan

Manual: select a Revit equipment family in a test model, run sync, verify DB updated.

## Doc updates (in-scope)

- `README.md`: update Phase 4 description

## Blocked by

#47, #48
EOF
```

- [ ] **Step 8: Create Issue O**

```bash
gh issue create \
  --title "feat(revit): Phase 4d — Part 2 auto-population from Revit family instances" \
  --body-file /tmp/specr-issue-o.md \
  --label "phase:4" \
  --milestone "Phase 4"
```

Expected: `/issues/49`

- [ ] **Step 9: Write Issue P body**

```bash
cat > /tmp/specr-issue-p.md << 'EOF'
## Context

Ongoing sync: detect when Revit model parameters changed since last push and surface a diff before allowing the next push. Prevents silent overwrites when parameters change incrementally.

## Scope

**Modify:**
- `revit-addin/` — add `ChangeDetector.cs`:
  - Caches last-synced parameter values per Revit element (persisted to a local JSON file in `%APPDATA%\SpecRAddin\`)
  - On next sync: compares current Revit values against cache
  - If no changes: shows "No changes since last sync"
  - If changes: surfaces only changed parameters in the preview dialog

## Acceptance criteria

- [ ] Second sync with unchanged Revit model → "No changes detected"
- [ ] Second sync with a changed parameter → preview shows only that parameter
- [ ] Cache survives Revit session restart

## Test plan

Manual: sync once, change a parameter in Revit, sync again, verify only the changed parameter appears.

## Doc updates (in-scope)

- `README.md`: update Phase 4 status to "Complete ✅"

## Blocked by

#49
EOF
```

- [ ] **Step 10: Create Issue P**

```bash
gh issue create \
  --title "feat(revit): Phase 4e — Revit change detection + diff preview" \
  --body-file /tmp/specr-issue-p.md \
  --label "phase:4" \
  --milestone "Phase 4"
```

Expected: `/issues/50`

- [ ] **Step 11: Verify Phase 4**

```bash
gh issue list --milestone "Phase 4" --json number,title -q '.[] | "\(.number): \(.title)"'
```

Expected: `46`, `47`, `48`, `49`, `50` (5 issues).

---

### Task 12: Final verification

**Files:** none

- [ ] **Step 1: Total issue count**

```bash
gh issue list --state open --json number --limit 100 | jq 'length'
```

Expected: `26` (24 new + #13 ADR-011 + ... wait, count only open issues that are new)

More precisely, verify all 24 new issues exist:

```bash
gh issue list --state open --json number,title --limit 100 \
  | jq -r '.[] | "\(.number): \(.title)"' | sort -n
```

Expected: issues #27–#50 all present.

- [ ] **Step 2: Verify #20 is closed**

```bash
gh issue view 20 --json state -q .state
```

Expected: `CLOSED`

- [ ] **Step 3: Verify milestone issue counts**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api repos/$REPO/milestones \
  | jq -r '.[] | "\(.title): \(.open_issues) open"'
```

Expected:
```
Phase 1c: 1 open
Phase 2b: 2 open
Phase 2c: 3 open
Phase 3: 4 open
Phase 5: 8 open
Phase 4: 5 open
```

- [ ] **Step 4: Clean up temp files**

```bash
rm -f /tmp/specr-issue-{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x}.md
```

---

## Self-Review

**Spec coverage:**
- 6 labels ✓ (Task 2)
- 6 milestones ✓ (Task 3)
- #20 closed ✓ (Task 4)
- 24 issues A–X ✓ (Tasks 5–11)
- Phase 5 before Phase 4 ✓ (Tasks 10, 11)
- All "Blocked by" use predicted issue numbers ✓

**Placeholder scan:** No TBD/TODO. All issue bodies complete. `NNNN` in migration filenames is intentional — actual numbers depend on what's already in `src/db/migrations/` at implementation time.

**Type consistency:** `DiffResult`, `ParagraphSnapshot`, `MergeError` defined in Issue H (#34) and referenced in Issues I (#35) and J (#36). `StyleTemplate` referenced in Issue F (#32) — implementer must define this type in `src/db/queries/templates.ts` when building Issue D (#30). `ApiResponse<T>` is the existing project-wide response shape.
