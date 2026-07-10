# Phased Delivery

> ↩ [Architecture index](../../ARCHITECTURE.md)

## Phase 0: Foundation (Weeks 1–2)
- Project scaffolding (TypeScript, Express, PostgreSQL, ESLint, Prettier, Zod)
- CSI division/section reference data seeded to DB
- Paragraph tree schema + migrations
- Basic CRUD API (`GET /specs/:id`, `PATCH /specs/:id`)
- CI pipeline (lint + test + build + LOC check)

## Phase 1: Parser (Weeks 3–6)

Sub-MVP 1a: UFGS parser + cross-reference model
- `projects` / `project_specs` / `spec_references` DB migrations (schema only, no API)
- UFGS .SEC parser: SpecsIntact XML → canonical AST → PostgreSQL
- Cross-reference extraction at parse time → `spec_references` table
- Bulk corpus loader: all 666 UFGS .SEC files → library namespace

Sub-MVP 1b: Project + TOC API
- `POST /projects`, `GET /projects/:id`
- TOC management: add/remove spec sections from a project
- TOC-level cascade: removing a section auto-purges dangling `spec_references`, marks broken refs on remaining sections
- `GET /projects/:id/references/broken`: surface broken refs for spec writer review

Sub-MVP 1c-i: DOCX numbering + style analyzers (complete, PR #17)
- DOCX `numbering.xml` analyzer (abstractNum → num → pStyle map, articleIlvl auto-detection)
- DOCX `styles.xml` analyzer (basedOn chains, numPr-carrying styles, Clippit numId=0 chain-stop)
- Intermediate types: `NumberingMap`, `StyleMap`, `DocxParagraph`
- Extraction rule constants (`ARCAT_ILVL_MAP`, `CPI_ILVL_MAP`, `SECTION_REF_RULES`) as typed MCP-surfaceable data

Sub-MVP 1c-ii: DOCX hierarchy inference + `POST /parse` (issue #12)
- `document.ts`: extract `DocxParagraph[]` from `word/document.xml` (JSZip + fast-xml-parser)
- `heuristics.ts`: signal 4 (text regex, anchored to `^`, min-length guard) + signal 5 (indentation / 576 twips)
- `inference.ts`: two-pass engine: pass 1 signal priority chain (1→5) with conflict logging; pass 2 stack-based tree construction
- `index.ts`: DOCX orchestrator with `onProgress` callback for async job tracking
- `POST /parse` + `GET /parse/jobs/:jobId`: async job pattern (202 + poll) for progress surfacing in Phase 5 UI
- Test against ARCAT fixtures first (machine-generated, cleanest), CPI second

Sub-MVP 1c-iii: DOCX cross-reference extraction (follow-up)
- Run `SECTION_REF_RULES` regex over DOCX paragraph text → `spec_references` table
- Parity with .SEC parser cross-reference extraction

## Phase 2: Generator + MCP Foundation (Weeks 5–7, overlaps Phase 1)

**Phase 2a: MCP server + Markdown renderer**
- MCP server integrated into Express via Streamable HTTP (`POST /mcp`, `GET /mcp` 405 stub, `DELETE /mcp` 405 stub): stateless `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`, one `McpServer` instance per request. Supersedes ADR-010's original stdio/SSE stance; see ADR-010 Decision Update.
- `src/generator/markdown.ts`: pure function `renderMarkdown(CsiTree): string` + `getLabel(NodeType, index, partNumber?)`. `note` nodes render as `> **[NOTE]**` blockquotes (not hidden) in MCP output, while `meta.vanish` on non-note nodes is suppressed. Shared with future DOCX generator and Phase 6.
- MCP tools (read-only Phase 2a scope): `search_library(query, division?, limit?)`, `get_spec(specId)` → `{ tree: CsiTree, references: SpecReference[] }` (each reference includes `isResolved: boolean`), `list_sections(division?)`
- MCP resources: `specr://specs/{id}` (Markdown), `specr://sections` (Markdown table)
- Auth: none for Phase 2. Auth hook comment in `src/mcp/server.ts`; auth added in same PR as REST auth (future).
- **Stateful sessions (Phase 5h, #45):** `POST /mcp` now also serves optional stateful sessions. An `initialize` with no `mcp-session-id` header mints a session (`sessionIdGenerator: () => randomUUID()`); the session's transport+server pair is kept in a `McpSessionStore` (`src/mcp/sessions.ts`) keyed by the minted id, and reused for later requests carrying that header. `DELETE /mcp` closes and removes a session. Stateless callers (no header) still get a fresh transport per request. Tool/resource definitions unchanged.
- Deferred to later phases: write tools, MCP prompts, GET /mcp SSE streaming

**Phase 2b: Core DOCX generator** ✅ Complete (PR #26, PR #28)

- **2b-i** ✅: `generateDocx()` + `buildCsiNumberingConfig()`, 7-level CSI multilevel numbering, `POST /specs/:id/generate` endpoint (PR #26)
- **2b-ii** ✅: `wrapWithControl()`, `SdtBlock extends FileChild`, `specr-uuid-<CsiNode.id>` tags in `w:sdtPr` as round-trip merge anchors per ADR-004 (PR #28). Uses `StringValueElement('w:tag', ...)` for idiomatic docx-native attribute injection. Title paragraph intentionally bare: synthetic, no DB id.
- **2b-iii** ✅: `get_paragraph(paragraphId)` → `{ node, ancestors[] }` ancestor chain via recursive CTE; `parse_document(filename, contentBase64)` → ingest DOCX/SEC via MCP with base64 encoding; `generate_docx(specId)` → on-demand base64 DOCX. (closes #29)

**Phase 2c: Firm style template engine (issue #20)** ✅ Complete
- ✅ `style_templates` + `style_rules` DB tables; default CSI styles seeded at migration (PR #87); JSONB `properties` payload per ADR-021 (migration 014)
- ✅ `templateId?` in the `POST /specs/:id/generate` body resolves to template rules and is applied by `generateDocx`: per-NodeType font/spacing/indent on styled paragraphs, `numFmt`/`lvlText`/`start` overrides on the numbering definition. Omitted → seeded `UFGS-Default` (so an explicit default-template request is identical to a bare request); unknown id → 404 (issue #32)
- ✅ Template import API: `POST /templates`, `POST /templates/:id/rules` CRUD (PR #156); `POST /templates/import` DOCX consensus derivation (PR #151)
- ✅ Prerequisite for Phase 5 live preview: generate DOCX → blob → client render

## Phase 3: Merge Engine (Weeks 7–9) — ✅ Complete
- UUID-based paragraph matching across round-trips
- 3-way diff algorithm (base + theirs + ours)
- Conflict detection
- `POST /specs/:id/diff` and `POST /specs/:id/merge` endpoints
- End-to-end test: parse → generate → edit returned DOCX text → diff → merge → verify

## Phase 4: Revit Integration (Weeks 10–12)
- Revit parameter → CSI paragraph mapping schema
- Revit add-in (C#/.NET) calling SpecR API directly: **separate C# solution in `revit-addin/`** (own `dotnet` toolchain, independent of the pnpm/TS build). Phase 4c scaffold: `IExternalApplication` ribbon registration + typed Refit REST client against `openapi.yaml` (`SpecRClient.GetSpecAsync`/`GetHealthAsync`). Targets the Revit 2024 runtime (.NET Framework 4.8). See `revit-addin/README.md`.
- Part 2 auto-population from Revit model data
- Revit change detection → show spec diffs

## Phase 5: Web UI (Weeks 12–16)
- Spec editor (tree view, inline editing)
- Diff/merge review interface
- Firm library management
- Style template configuration
- User management + multi-firm support

## Phase 6: Scale (Ongoing)
- MCP prompts: `review_spec`, `suggest_paragraphs` (AI-assisted spec writing workflows)
- Autodesk Platform Services (APS/Forge) cloud integration
- Full-text search across paragraph libraries
- DOCX cache layer: pre-generate + store DOCX on spec write, invalidate on paragraph change, locking to prevent stale reads (see issue #52)
