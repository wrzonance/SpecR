# SpecR

Headless REST API for CSI MasterFormat specification document automation with round-trip DOCX support.

## What Is This

SpecR treats construction specification documents as structured data with true parent/child paragraph relationships — not opaque Word files. It parses DOCX and UFGS `.SEC` specifications into a canonical CSI AST, stores them in PostgreSQL, and will regenerate them with full numbering fidelity. It targets git-style 3-way merge when edited documents come back from reviewers.

The target: In a Web UI, a spec writer connects a Revit model, sees their Part 2 (Products) sections auto-populate from equipment families, is able to export clean DOCX files, receives a redlined version from the Owner, and merges accepted changes back into the database — all without manual transcription; but still with full control and manual bi-directional editing of paragraph language in the database.

## Status

**Active development — Phase 1c in progress.**

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Foundation — scaffolding, DB schema, seed data, CRUD API, CI | ✅ Complete |
| 1a | UFGS `.SEC` parser + cross-reference model | ✅ Complete |
| 1b | Project + TOC management API | ✅ Complete |
| 1c-i | DOCX `numbering.xml` + `styles.xml` analyzers (Clippit-ported) | ✅ Complete (PR #17) |
| 1c-ii | 5-signal hierarchy inference engine | 🔨 In progress |
| 2 | Generator (AST → DOCX) + MCP server scaffold | Planned |
| 3 | Round-trip merge engine | Planned |
| 4 | Revit integration | Planned |
| 5 | Web UI | Planned |

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full specification and [`docs/research-executive-summary.md`](docs/research-executive-summary.md) for the landscape analysis.

## What Works Today

### Parsing

- **UFGS `.SEC` parser** — SpecsIntact XML → canonical `CsiTree` with `CsiNode` hierarchy. Extracts `<PRT>` / `<SPT>` / `<TXT>` elements into Part → Article → PR1–PR5 levels. Parses cross-references between sections at ingest time.
- **DOCX `numbering.xml` analyzer** — builds the complete `abstractNum → num → paragraph style` linkage map. Handles `basedOn` inheritance chains, `lvlOverride` overrides, and the Clippit `ListItemRetriever` sentinel: `numId=0` as explicit numbering suppression (halts `basedOn` traversal rather than inheriting parent numbering). This correctly handles CPI continuation styles (`PR1lc`–`PR5lc`) which represent ~34% of document content.
- **DOCX `styles.xml` analyzer** — resolves full `basedOn` chains, identifies `numPr`-carrying styles, and propagates `suppressesNumbering` through style inheritance. Produces the style map consumed by the inference engine.
- **Extraction rules as typed data constants** — numbering and style rules are defined as MCP-readable data structures, not code, enabling LLM agent exploration and parse explainability.

### API

- `GET /health` — liveness check
- `GET /specs/:id` — retrieve a spec with its paragraph tree
- `PATCH /specs/:id` — update spec metadata
- `POST /projects` — create a project
- `GET /projects/:id` — retrieve project with TOC
- `POST /projects/:id/specs` — add a spec section to a project TOC
- `DELETE /projects/:id/specs/:specId` — remove a section, cascades dangling cross-references
- `GET /projects/:id/references/broken` — surface broken cross-references for spec writer review

### Database

- PostgreSQL schema: `specs`, `paragraphs` (recursive parent/child), `versions`, `projects`, `project_specs`, `spec_references`
- All 50 CSI MasterFormat divisions seeded as reference data
- Migration runner with reversible up/down migrations

## Not Yet Built

- `POST /parse` — the DOCX upload endpoint (depends on the inference engine, Phase 1c-ii)
- AST → DOCX generator (Phase 2)
- MCP server (Phase 2)
- Round-trip merge engine (Phase 3)
- Revit integration (Phase 4)
- Web UI (Phase 5)

## The Core Technical Challenge

DOCX files store paragraphs flat — parent/child hierarchy must be inferred. No single signal is reliable across all firms and authoring conventions. The inference engine (Phase 1c-ii) combines five signals with weighted confidence:

| Signal | Source | Reliability |
|--------|--------|-------------|
| 1. Numbering XML | `numbering.xml` abstractNum→num→pStyle map | Highest |
| 2. Style chain | `styles.xml` basedOn traversal + numPr identification | High for clean documents |
| 3. Document order | `ilvl` transitions in paragraph sequence | Medium |
| 4. Text content | Regex for leading patterns (`A.`, `1.`, `PART 1`) | Medium |
| 5. Indentation | Left indent follows CSI staircase (~576 twips/0.4" per level) | Fallback |

This is a TypeScript port of Clippit's `ListItemRetriever` (C#, MIT), extended with signals 4 and 5 for real-world messy documents.

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
| DOCX generation | dolanmiu/docx (planned) |
| DOCX parsing | JSZip + raw OOXML (no TS library does style inheritance) |
| SEC parsing | fast-xml-parser |
| MCP server | @modelcontextprotocol/sdk (planned) |
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

## Reference Data

- `docs/references/UFGS/` — Unified Facilities Guide Specifications (666 `.SEC` files, public domain)
- `docs/references/ARCAT/README.md` — Download instructions for ARCAT guide specs (copyrighted, not included)
- `docs/references/MANUFACTURER_CPI/README.md` — Download instructions for Chatsworth Products Inc. (CPI) telecom equipment manufacturer specs (copyrighted, not included)

## License

TBD (will be open source)
