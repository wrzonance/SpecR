# SpecR

Headless REST API for CSI® MasterFormat®-compatible specification document automation with round-trip DOCX support. Independent project; not affiliated with CSI.

## What Is This

SpecR treats construction specification documents as structured data with true parent/child paragraph relationships — not opaque Word files. It parses DOCX and UFGS `.SEC` specifications into a canonical CSI AST, stores them in PostgreSQL, and will regenerate them with full numbering fidelity. It targets git-style 3-way merge when edited documents come back from reviewers.

The target: In a Web UI, a spec writer connects a Revit model, sees their Part 2 (Products) sections auto-populate from equipment families, is able to export clean DOCX files, receives a redlined version from the Owner, and merges accepted changes back into the database — all without manual transcription; but still with full control and manual bi-directional editing of paragraph language in the database.

## Status

**Active development — Phase 1c + 2b + 2c complete, Phase 2d next.**

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Foundation — scaffolding, DB schema, seed data, CRUD API, CI | ✅ Complete |
| 1a | UFGS `.SEC` parser + cross-reference model | ✅ Complete |
| 1b | Project + TOC management API | ✅ Complete |
| 1c-i | DOCX `numbering.xml` + `styles.xml` analyzers (Clippit-ported) | ✅ Complete (PR #17) |
| 1c-ii | 5-signal hierarchy inference engine + `POST /parse` async endpoint | ✅ Complete (PR #21) |
| 1c-iii | DOCX cross-reference extraction — format-agnostic refs module | ✅ Complete (PR #76) |
| 1c-iv | Plaintext `.txt` parser — 4-signal hierarchy inference, read-only ingest | ✅ Complete (PR #66) |
| 1c-v | Plaintext signal hardening — noise-prefix strip + joined-prefix lookahead | ✅ Complete (PR #70) |
| 1c-vi | Parse-anomaly warnings — `meta.warnings` on `SpecTree`, `parse-warnings` capability | ✅ Complete (PR #75) |
| 1c-vii | DOCX resilience — LibreOffice fixture + integration tests | ✅ Complete (PR #72) |
| 1c-viii | Integration test serialization — `fileParallelism: false` deflakes shared-DB race | ✅ Complete (PR #74) |
| 1c-sec-i | MCP rate limiting on `POST /mcp` — DoS hardening for `parse_document` / `generate_docx` | ✅ Complete (PR #69) |
| 1c-sec-ii | Parse worker concurrency cap — piscina worker pool | ✅ Complete (PR #71) |
| 1c-ix | Expanded section-number grammar — `NN NN NN[.NN[ NN]]` (Level 4 dotted + Level 5 agency suffixes) across parsers, inference, refs, API, and DB — see [ADR-020](docs/adr/020-section-number-expanded-shape.md) | ✅ Complete (PRs #114–#117) |
| 2a | MCP server (Streamable HTTP, read-only tools + resources) + Markdown renderer | ✅ Complete (PR #24) |
| 2b-i | AST → DOCX generator + 7-level CSI multilevel numbering | ✅ Complete (PR #26) |
| 2b-ii | `w:sdt` content control UUID injection (round-trip anchors) | ✅ Complete (PR #51) |
| 2b-iii | MCP tools: `get_paragraph`, `parse_document`, `generate_docx` | ✅ Complete (PR #55) |
| 2b-iv | Universal file loader: `load:files`, `seed:corpus`, `load_files` MCP tool | ✅ Complete (PR #60) |
| 2c-i | Style template DB schema — `style_templates` + `style_rules` + default rules seed | ✅ Complete (PR #87) |
| 2c-ii | Template CRUD API over the JSONB style payload (ADR-021) + `POST /templates/import` DOCX style derivation | ✅ Complete (PRs #151, #156) |
| 2c-iii | `templateId` wired through generator — template font/spacing/indent/numbering applied to generated DOCX; `UFGS-Default` applied when omitted | ✅ Complete (issue #32) |
| 2c | Firm style template engine (issue #20) | ✅ Complete |
| 2d | Library hierarchy + chain of custody — masters, project copies, packages, issuances — see [ADR-015](docs/adr/015-layered-spec-hierarchy-chain-of-custody.md) | Planned |
| 2e | Project-manual publishing — assembly, cover/TOC, addenda — see [ADR-017](docs/adr/017-project-manual-publishing.md) | Planned |
| 3 | Round-trip merge engine | Planned |
| 4a | Revit parameter mapping schema + migrations | ✅ Complete (PR #86) |
| 4 | Revit integration | Planned |
| 5 | Web UI | Planned |
| 6 | Scale — APS/Forge, full-text search, DOCX cache, MCP prompts | Planned |
| 7 | DMS connector framework (ProjectWise + pluggable backends) — see [ADR-014](docs/adr/014-dms-connector-framework.md) | Planned |

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full specification and [`docs/research-executive-summary.md`](docs/research-executive-summary.md) for the landscape analysis.

## What Works Today

### Parsing

- **UFGS `.SEC` parser** — SpecsIntact XML → canonical `SpecTree` with `SpecNode` hierarchy. Extracts `<PRT>` / `<SPT>` / `<TXT>` elements into Part → Article → PR1–PR5 levels. Parses cross-references between sections at ingest time.
- **Encoding-transparent ingest** — `.sec` files are decoded via chardet + iconv-lite before parsing: `windows-1252`, `latin-1`, UTF-8, and ~100 other encodings detected and transcoded automatically. No manual encoding flag needed. (`.docx` is a binary ZIP — encoding is not a concern.)
- **DOCX `numbering.xml` analyzer** — builds the complete `abstractNum → num → paragraph style` linkage map. Handles `basedOn` inheritance chains, `lvlOverride` overrides, and the Clippit `ListItemRetriever` sentinel: `numId=0` as explicit numbering suppression (halts `basedOn` traversal rather than inheriting parent numbering). This correctly handles CPI continuation styles (`PR1lc`–`PR5lc`) which represent roughly one-third of document content in CPI samples.
- **DOCX `styles.xml` analyzer** — resolves full `basedOn` chains, identifies `numPr`-carrying styles, and propagates `suppressesNumbering` through style inheritance. Produces the style map consumed by the inference engine.
- **DOCX `word/document.xml` extractor** — walks paragraph sequence via JSZip + fast-xml-parser, extracts text (multi-run concat), styleId, numId/ilvl, left indent, outlineLvl, and vanish flag. Merges style-inherited numPr when paragraph has no own `w:numPr`.
- **5-signal hierarchy inference engine** — two-pass pipeline: Pass 1 classifies each paragraph using a priority chain (numbering XML > style chain > text regex > indentation), logging signal conflicts into `meta.conflicts` for MCP surfacing. Pass 2 builds the parent/child tree using a stack algorithm (handles ilvl gaps, jumps, continuation paragraphs, and hidden note nodes). Source template (`arcat` / `cpi` / `unknown`) auto-detected from style names and numbering.xml heuristics.
- **DOCX cross-reference extraction** — format-agnostic refs module (`src/parser/refs/`) walks the canonical `SpecTree` after inference; extracts CSI section refs (`Section XX XX XX[.XX[ XX]]` — Level 4 dotted and Level 5 agency suffixes are distinct section identities, never truncated) and standards-org refs for ASTM, ANSI, IEEE, NFPA, UL, NEMA, NEC, TIA, BICSI, ASME, ASHRAE. Refs flow into `spec_references` and participate in `GET /projects/:id/references/broken` cascade detection.
- **Extraction rules as typed data constants** — numbering, style, and signal rules are defined as MCP-readable data structures, not code, enabling LLM agent exploration and parse explainability.
- **Plaintext `.txt` parser** — infers CSI hierarchy from text signals: `PART N` headings, `N.N` article numbers, `A.`/`1.`/`a.`/`1)`/`a)` prefix patterns, and leading-whitespace indentation depth as fallback. Section and title extracted from the `SECTION XX XX XX[.XX[ XX]]` header line (scans first 10 non-blank lines, suffix-aware); falls back to `inferSectionMeta`. Read-only — no round-trip merge anchors. `POST /parse` accepts `.txt` uploads; `load_files` MCP tool and `pnpm load:files` CLI accept `**/*.txt` globs; `parse_document` MCP tool accepts `.txt` filenames. Parse job result and MCP response include `capabilities: ["read-only"]`.
- **Plaintext signal hardening** — noise prefixes on structural headings (`] PART 2 PRODUCTS`, en-dash variants, joined `PART2PRODUCTS`) detected via prefix-strip + lookahead pass before signal classification. Prevents silent fall-through to `continuation` when bracket-bleed or formatting artifacts pollute the leading characters. (PR #70)
- **Parse-anomaly warnings** — text parser emits structured `ParseWarning[]` on the returned `SpecTree` when anomalies are detected: `root-continuation` (continuations dropped before first structural heading; capped at 5), `empty-part` (a `part` node with zero article children, with `"line N: <text>"` hint), `no-structure-found` (zero parts). Parse job result adds `"parse-warnings"` to `capabilities` when any warning fires; MCP `parse_document` returns the same envelope. Observability layer; nothing persisted to DB. (PR #75)
- **DOCX resilience suite** — integration fixture coverage for LibreOffice-exported DOCX, in addition to ARCAT and CPI vendor templates. Numbered-list false-positive in LibreOffice exports fixed (Signal 1 over-eager match). (PR #72)
- **Numbering-generated PART headings** — ARCAT-style part headings whose literal text is just `GENERAL` / `PRODUCTS` / `EXECUTION` (the `PART %1` prefix lives in numbering.xml `lvlText`) are recognized via a spec-shaped-ladder test on the linked style chain. Fuzzy `NOTE TO SPECIFIER` detection produces hidden `note` nodes (parity with SEC `NTE` handling), and a sanity post-pass audits the tree (`no-structure-found`, `root-continuation`, `unusual-part-count`). (PR #113)
- **SEC XML entity decoding** — character entities in `<TXT>` content are decoded at parse time, so `O&M` no longer surfaces as `O&amp;M`. (PR #112)

### Generator

- `POST /specs/:id/generate` → streams DOCX buffer with 7-level CSI multilevel numbering
- Optional `{ templateId }` body applies a style template's font/spacing/indent/numbering-format rules per CSI node type; omitted → seeded `UFGS-Default`; unknown id → 404 (issue #32)
- Each paragraph wrapped in `w:sdt` content control with `specr-uuid-<id>` UUID tag — round-trip merge anchors per ADR-004. Phase 3 merge engine reads these tags to map owner-redlined paragraphs back to `paragraphs.id`.
- Title paragraph intentionally bare (synthetic, no DB id) — Phase 3 merge skips unwrapped paragraphs.

### API

- `GET /health` — liveness check
- `POST /parse` — upload a `.docx` or `.sec` file; returns `202 { jobId }` immediately (async)
- `GET /parse/jobs/:jobId` — poll parse progress: `{ status, progress: { stage, pct }, result?, error? }`
- `GET /specs/:id` — retrieve a spec with its paragraph tree
- `POST /specs/:id/generate` — generate DOCX from stored spec AST (optional `{ templateId }` style template)
- `PATCH /specs/:id` — update spec metadata
- `POST /projects` — create a project
- `GET /projects/:id` — retrieve project with TOC
- `POST /projects/:id/specs` — add a spec section to a project TOC
- `DELETE /projects/:id/specs/:specId` — remove a section, cascades dangling cross-references
- `GET /projects/:id/references/broken` — surface broken cross-references for spec writer review
- `POST /templates` — create a style template (no rules; returns `TemplateMeta`)
- `GET /templates` — list all templates (metadata only)
- `GET /templates/:id` — retrieve a template with its style rules
- `PATCH /templates/:id` — update template name and/or owner (`owner: null` clears it)
- `DELETE /templates/:id` — delete a template and cascade-remove its rules (204)
- `POST /templates/:id/rules` — bulk-upsert style rules (transactional; one invalid rule rolls back all)
- `POST /templates/import` — derive a firm style template from a source-of-truth DOCX

The async `POST /parse` pattern (202 + poll) is intentional — inference over large DOCX files takes measurable time, and the job endpoint is designed for Phase 5 Web UI progress bars without further backend changes.

### MCP Server

- `POST /mcp` — MCP JSON-RPC endpoint (Streamable HTTP, stateless, integrated into Express). Rate-limited via `express-rate-limit` (DoS hardening; `parse_document` and `generate_docx` are CPU/memory-bound and require the gate). (PR #69)
- **Tool: `search_library(query, division?, limit?)`** — ILIKE paragraph search with optional CSI division filter. Returns `{ paragraphId, text, nodeType, specId, specSection, specTitle }[]`
- **Tool: `get_spec(specId)`** — full spec tree + cross-reference resolution. Returns `{ tree: SpecTree, references: SpecReference[] }` where each reference has `isResolved: boolean` (whether target spec is loaded in DB). DOCX-parsed nodes may carry `meta.conflicts` — inference signal disagreements for trust calibration (#56)
- **Tool: `list_sections(division?)`** — CSI MasterFormat section index with `inDatabase` flag
- **Tool: `get_paragraph(paragraphId)`** — returns `{ node, ancestors }` for a single paragraph. `node` and each ancestor are `{ id, nodeType, text, vanish, conflicts? }` — `conflicts` present only when the DOCX inference engine recorded signal disagreements. Ancestors ordered root → immediate parent.
- **Tool: `parse_document(filename, contentBase64)`** — base64-decode a DOCX or SEC file, parse it, insert into the database, return `{ specId, section, title, nodeCount }`. Max 10 MB decoded. Encoding-transparent for `.sec` files.
- **Tool: `generate_docx(specId)`** — generate DOCX from a stored spec, returned as base64 in `{ specId, section, title, sizeBytes, contentBase64 }`. Each paragraph wrapped in `w:sdt` UUID content control. On-demand from current DB state — not cached.
- **Tool: `load_files(glob?, paths?, dry_run?)`** — bulk-load specs from a glob pattern or file path list. Accepts `.SEC` and `.docx` formats. Returns `{ total, succeeded, failed, errors[] }`. Idempotent — re-loading an existing spec updates it.
- **Resource: `specr://specs/{id}`** — full spec as LLM-readable Markdown. Note/vanish nodes rendered as `> **[NOTE]**` blockquotes (editor instructions visible to spec writer, hidden from published output)
- **Resource: `specr://sections`** — full CSI section index as Markdown table with loaded (✓) flag

Configure in Claude Code by creating a `.mcp.json` in the repo root (gitignored) pointing at `http://localhost:3000/mcp` while `pnpm dev` is running.

### Database

- PostgreSQL schema: `specs`, `paragraphs` (recursive parent/child), `paragraph_versions`, `projects`, `project_specs`, `spec_references`, `spec_sections` (CSI section catalog), `style_templates` + `style_rules` (Phase 2c-i), `revit_parameter_mappings` (Phase 4a)
- 31 CSI MasterFormat divisions seeded from UFGS corpus as reference data (666 section records, 239 with Level 4/5 suffixes)
- Section-number shape CHECK constraints — `specs.section` and `spec_sections.section_number` enforce the expanded grammar at the DB layer ([ADR-020](docs/adr/020-section-number-expanded-shape.md)); `spec_references.target_spec_section` deliberately unconstrained (records what the source document said)
- Migration runner with reversible up/down migrations

### Template Import (Style Fidelity)

`POST /templates/import` accepts a multipart `.docx` file plus a `name` (required) and `owner` (optional). It derives a reusable firm style template via per-NodeType consensus derivation: for each of the seven CSI paragraph roles (`part`, `article`, `pr1`–`pr5`), all non-vanish paragraphs that carry a recognised Word style ID vote on each OOXML property leaf; a strict majority (>50%) wins as `consensus`, falling back to the modal style's own value as `intent`, then `median` for numeric properties, then `mode` — per §5 of the style fidelity program spec. The endpoint returns both the persisted template (`{id, name, owner, createdAt, rules}`) and a `DerivationReport` that records confidence scores, `disagreesWithIntent` flags, and rejected outlier values for every property decision, so spec writers can review the derivation before accepting the template as authoritative. The raw DOCX is never stored — only the derived JSONB style definition is persisted (ADR-021). **Theme fonts:** `asciiTheme`/`hAnsiTheme`/`cstheme`/`eastAsiaTheme` references in `w:rFonts` are resolved through `word/theme/theme1.xml` (issue #149). Per ECMA-376 §17.3.2.26 the theme attribute supersedes its direct counterpart within the same element; cross-level cascade pair-slot clearing is also applied. A direct font value wins when the theme part is absent or the token is unresolvable. The original theme token keys are kept in the style payload as provenance.

## Not Yet Built

- Round-trip merge engine (Phase 3)
- Revit integration (Phase 4)
- Web UI with progress bars, live preview, diff/merge review (Phase 5)
- MCP write tools (`add_paragraph`, `update_paragraph`, etc.) — Phase 5
- MCP stateful sessions — Phase 5 upgrade
- MCP prompts (`review_spec`, `suggest_paragraphs`) — Phase 6

## The Core Technical Challenge

DOCX files store paragraphs flat — parent/child hierarchy must be inferred. No single signal is reliable across all firms and authoring conventions. The inference engine combines five signals in a priority chain:

| Signal | Source | Reliability |
|--------|--------|-------------|
| 1. Numbering XML | `numbering.xml` abstractNum→num→pStyle map | Highest — what Word actually respects |
| 2. Style chain | `styles.xml` basedOn traversal + numPr identification | High for clean documents |
| 3. Document order | Continuation fallback when no other signal fires | Always present |
| 4. Text content | Anchored regex for leading patterns (`^A\.\s`, `^1\.\s`, `^PART\s+\d+`) | Medium — guards against mid-word false positives |
| 5. Indentation | Left indent ÷ 576 twips ≈ CSI hierarchy level | Low-confidence fallback |

Signals that disagree with the winner are recorded in `meta.conflicts` per node — available for MCP surfacing and future confidence scoring. Built as a TypeScript port of Clippit's `ListItemRetriever` (C#, MIT), extended with signals 4 and 5 for real-world messy documents.

### Dev Tool

```bash
pnpm tsx scripts/parse-debug.ts <file.docx>
```

Parses a DOCX file locally (no server, no DB) and prints the inferred hierarchy with signal attribution:

```text
Parsed:  unknown — unknown
Source:  arcat
Nodes:   57

GENERAL                                                   [part, src:arcat]
  SECTION INCLUDES                                          [article, src:arcat]
    Project Identification: ((Name and location)).            [pr1, src:arcat]
      Existing site conditions and restrictions: (())           [pr2, src:arcat]
    Coordination:                                             [pr1, src:arcat]
       Coordinate the work of all trades.                       [continuation, src:arcat]
```

Note: `section` and `title` show as `unknown` when `docProps/core.xml` is absent from the file — common in vendor-generated ARCAT specs. The `Source:` field and node type inference are unaffected.

## CSI Numbering Hierarchy

| Level | CSI Role | Format |
|-------|----------|--------|
| Part | Part heading | `PART 1 - GENERAL` |
| Article | Section heading | `1.1 REFERENCES` |
| PR1 | First tier | `A. text` |
| PR2 | Second tier | `1. text` |
| PR3 | Third tier | `a. text` |
| PR4 | Fourth tier | `1) text` |
| PR5 | Fifth tier | `a) text` |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js 22 LTS |
| API framework | Express |
| Database | PostgreSQL (recursive CTEs, JSONB) |
| Input validation | Zod |
| DOCX generation | dolanmiu/docx (Phase 2b) |
| DOCX parsing | JSZip + raw OOXML (no TS library does style inheritance) |
| SEC parsing | fast-xml-parser |
| MCP server | @modelcontextprotocol/sdk (Streamable HTTP, stateless) |
| Logging | pino |

## Development

```bash
pnpm install

# Requires PostgreSQL — start via Docker:
docker compose up -d postgres

pnpm dev          # Development server (hot reload)
pnpm test         # Unit tests (no DB required)
pnpm test:integration  # Integration tests (requires PostgreSQL)
pnpm lint         # ESLint + tsc --noEmit
pnpm format       # Prettier write
pnpm migrate      # Run pending DB migrations
```

| Script | Description |
|--------|-------------|
| `pnpm load:files <glob>` | Bulk-load spec files matching a glob pattern (`.SEC`, `.docx`) into the library |
| `pnpm seed:corpus` | Load all 666 UFGS `.SEC` files into the library — idempotent, safe to re-run |

## Reference Data

- `docs/references/UFGS/` — Unified Facilities Guide Specifications (666 `.SEC` files, public domain)
- `docs/references/ARCAT/README.md` — Download instructions for ARCAT guide specs (copyrighted, not included)
- `docs/references/MANUFACTURER_CPI/README.md` — Download instructions for Chatsworth Products Inc. (CPI) telecom equipment manufacturer specs (copyrighted, not included)

## Revit Add-In

A separate C#/.NET Revit add-in lives in [`revit-addin/`](revit-addin/README.md). It
connects Revit to a running SpecR instance through the REST API (Phase 4). The
Phase 4c scaffold registers a **SpecR** ribbon tab with a **Health Check** button
and ships a typed REST client (Refit) generated against `openapi.yaml`.

- **Toolchain:** independent of this repo's pnpm/TypeScript setup — build with
  `dotnet build` from `revit-addin/`. Targets the Revit 2024 runtime (.NET
  Framework 4.8).
- **Setup, build, and manual-load steps:** see [`revit-addin/README.md`](revit-addin/README.md).

