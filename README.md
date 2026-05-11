# SpecR

Headless REST API for CSI MasterFormat specification document automation with round-trip DOCX support.

## What Is This

SpecR treats construction specification documents as structured data with true parent/child paragraph relationships — not opaque Word files. It parses DOCX and UFGS `.SEC` specifications into a canonical CSI AST, stores them in PostgreSQL, and will regenerate them with full numbering fidelity. It targets git-style 3-way merge when edited documents come back from reviewers.

The target: In a Web UI, a spec writer connects a Revit model, sees their Part 2 (Products) sections auto-populate from equipment families, is able to export clean DOCX files, receives a redlined version from the Owner, and merges accepted changes back into the database — all without manual transcription; but still with full control and manual bi-directional editing of paragraph language in the database.

## Status

**Active development — Phase 1c complete, Phase 2 next.**

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Foundation — scaffolding, DB schema, seed data, CRUD API, CI | ✅ Complete |
| 1a | UFGS `.SEC` parser + cross-reference model | ✅ Complete |
| 1b | Project + TOC management API | ✅ Complete |
| 1c-i | DOCX `numbering.xml` + `styles.xml` analyzers (Clippit-ported) | ✅ Complete (PR #17) |
| 1c-ii | 5-signal hierarchy inference engine + `POST /parse` async endpoint | ✅ Complete (PR #21) |
| 2 | Generator (AST → DOCX) + MCP server scaffold | Planned |
| 3 | Round-trip merge engine | Planned |
| 4 | Revit integration | Planned |
| 5 | Web UI | Planned |

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full specification and [`docs/research-executive-summary.md`](docs/research-executive-summary.md) for the landscape analysis.

## What Works Today

### Parsing

- **UFGS `.SEC` parser** — SpecsIntact XML → canonical `CsiTree` with `CsiNode` hierarchy. Extracts `<PRT>` / `<SPT>` / `<TXT>` elements into Part → Article → PR1–PR5 levels. Parses cross-references between sections at ingest time.
- **DOCX `numbering.xml` analyzer** — builds the complete `abstractNum → num → paragraph style` linkage map. Handles `basedOn` inheritance chains, `lvlOverride` overrides, and the Clippit `ListItemRetriever` sentinel: `numId=0` as explicit numbering suppression (halts `basedOn` traversal rather than inheriting parent numbering). This correctly handles CPI continuation styles (`PR1lc`–`PR5lc`) which represent roughly one-third of document content in CPI samples.
- **DOCX `styles.xml` analyzer** — resolves full `basedOn` chains, identifies `numPr`-carrying styles, and propagates `suppressesNumbering` through style inheritance. Produces the style map consumed by the inference engine.
- **DOCX `word/document.xml` extractor** — walks paragraph sequence via JSZip + fast-xml-parser, extracts text (multi-run concat), styleId, numId/ilvl, left indent, outlineLvl, and vanish flag. Merges style-inherited numPr when paragraph has no own `w:numPr`.
- **5-signal hierarchy inference engine** — two-pass pipeline: Pass 1 classifies each paragraph using a priority chain (numbering XML > style chain > text regex > indentation), logging signal conflicts into `meta.conflicts` for MCP surfacing. Pass 2 builds the parent/child tree using a stack algorithm (handles ilvl gaps, jumps, continuation paragraphs, and hidden note nodes). Source template (`arcat` / `cpi` / `unknown`) auto-detected from style names and numbering.xml heuristics.
- **Extraction rules as typed data constants** — numbering, style, and signal rules are defined as MCP-readable data structures, not code, enabling LLM agent exploration and parse explainability.

### API

- `GET /health` — liveness check
- `POST /parse` — upload a `.docx` or `.sec` file; returns `202 { jobId }` immediately (async)
- `GET /parse/jobs/:jobId` — poll parse progress: `{ status, progress: { stage, pct }, result?, error? }`
- `GET /specs/:id` — retrieve a spec with its paragraph tree
- `PATCH /specs/:id` — update spec metadata
- `POST /projects` — create a project
- `GET /projects/:id` — retrieve project with TOC
- `POST /projects/:id/specs` — add a spec section to a project TOC
- `DELETE /projects/:id/specs/:specId` — remove a section, cascades dangling cross-references
- `GET /projects/:id/references/broken` — surface broken cross-references for spec writer review

The async `POST /parse` pattern (202 + poll) is intentional — inference over large DOCX files takes measurable time, and the job endpoint is designed for Phase 5 Web UI progress bars without further backend changes.

### Database

- PostgreSQL schema: `specs`, `paragraphs` (recursive parent/child), `versions`, `projects`, `project_specs`, `spec_references`
- 31 CSI MasterFormat divisions seeded from UFGS corpus as reference data
- Migration runner with reversible up/down migrations

## Not Yet Built

- AST → DOCX generator (Phase 2)
- MCP server (Phase 2)
- Style template engine — firm-specific fonts, spacing, numbering formats (Phase 2b, issue #20)
- Round-trip merge engine (Phase 3)
- Revit integration (Phase 4)
- Web UI with progress bars, live preview, diff/merge review (Phase 5)
- DOCX cross-reference extraction (Phase 1c-iii) — pending after Phase 2a
- Security hardening: ZIP bomb guard, MIME type validation for `POST /parse` (issue #19)

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

```
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
