# SpecR — Architecture Specification

> A headless REST API that treats CSI MasterFormat construction specification documents as structured data — not opaque Word files.

## Vision

Specification writers spend hours manually transcribing data from Revit models into Word documents. Reviewers mark up those documents, and writers manually reconcile changes back into their master files. SpecR eliminates this by parsing specification documents into a structured database, generating them parametrically, and tracking changes through a git-style merge engine.

The target: a spec writer who connects a Revit model, sees their Part 2 (Products) sections auto-populate from equipment families, exports a clean DOCX, receives a redlined version from the Owner, and merges accepted changes back into the database — all without manual transcription.

## Problem Statement

No open-source tool exists for CSI MasterFormat specification automation. Commercial tools (MasterSpec, SpecLink, SpecBuilder) dominate but share a fatal limitation: they don't integrate with BIM data programmatically. Revit models contain the ground truth of what's designed — equipment types, manufacturers, performance parameters — yet this data is manually copied into Word files.

The technical challenge is not any single feature but the intersection of five requirements:

1. **Company-agnostic parsing** — every firm uses different styles, numbering, and authoring conventions
2. **Round-trip fidelity** — documents leave the system, get manually edited, and must return without data loss
3. **Hierarchy inference** — DOCX stores paragraphs flat; parent/child relationships must be inferred
4. **Full numbering control** — CSI multilevel numbering must be reproduced exactly (liability issue)
5. **All divisions, all firms** — cannot be scoped to one division or one firm's template

## Design Principles

1. **Parse the real world.** Don't assume clean DOCX. Analyze all five signals (numbering XML, style chains, document order, text content, indentation) and combine them. Design for the messiest spec you'll encounter, not the cleanest.
2. **Round-trip is the product.** One-way generation is solvable. Round-trip through arbitrary manual editing is the hard part — and the value.
3. **API-first, always.** No UI in the core. Every feature is an API call. Clients are built on top.
4. **The AST is the source of truth.** Not the DOCX. Not the XML. The canonical CSI AST in PostgreSQL.
5. **Public domain first.** UFGS provides 666 spec files across all CSI divisions, hierarchy already explicit, no copyright friction. Seed the database before building the library management layer.
6. **Phases are gates.** MVP proves round-trip. Each subsequent phase adds one integration. Don't skip gates.
7. **AI-native from the start.** The canonical AST stores plain text — not OOXML encoding. Every design decision that makes the data readable to humans also makes it readable to LLMs. MCP exposure (ADR-010) is a natural consequence of this, not a retrofit.

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Language | **TypeScript** | DOCX generation ecosystem (dolanmiu/docx), future Office Add-in dev. Single language across server and potential Word add-in. |
| Runtime | **Node.js 22 LTS** | Long-term support, native fetch, TypeScript first-class |
| API framework | **Express** | Minimal, well-understood, no magic |
| Database | **PostgreSQL** | Recursive CTEs for paragraph tree queries. JSONB for AST storage. Row-level versioning. |
| Input validation | **Zod** | Runtime type safety at all system boundaries (requests, env, parsed XML) |
| DOCX generation | **dolanmiu/docx** | MIT, 5700★, 8M/week. Only TS library with full multilevel numbering control. Write-only — intentional for our use case. |
| DOCX parsing | **JSZip** (raw OOXML) | No TS library resolves OOXML style inheritance or builds list hierarchy. We implement the inference engine from first principles. |
| SEC parsing | **fast-xml-parser** | SpecsIntact XML (.SEC) uses a well-defined schema. Fast, zero deps. |
| MCP server | **@modelcontextprotocol/sdk** | Exposes SpecR as an AI tool — paragraph search, spec reading, diff review — via Model Context Protocol (ADR-010). |
| Logging | **pino** | Structured JSON logs, low overhead |
| HTTP upload | **multer** | Multipart DOCX/SEC file uploads |

### Why not Python

docx-parser-converter and Docling are better *parsers* than anything in the TS ecosystem. But dolanmiu/docx has no Python equivalent for *generation* with full numbering control. python-docx has no high-level list API — you escape to raw XML for anything beyond basic lists. Office Add-in development (Phase 4+) requires TypeScript regardless. One language wins.

### Why not Java

docx4j's `PropertyResolver` is the gold-standard ECMA-376 style resolver. But the JVM is a heavy runtime for a headless API, Java has no meaningful path to Office Add-in development, and the ecosystem investment is wrong for a TypeScript/Node-first architecture. The algorithms we need (Clippit's `ListItemRetriever`, docx4j's style cascade) are portable — we port them, not the runtime.

### Why not C#

Clippit is the only open-source library that builds the actual parent/child paragraph tree. We will port its `ListItemRetriever` algorithm to TypeScript. Running a .NET service alongside Node adds operational complexity with no benefit once the algorithm is ported.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Client Surfaces                                     │
│                                                                        │
│  REST API (Express)         MCP Server (stdio/SSE)                    │
│  ─────────────────          ───────────────────────                   │
│  POST /parse                tools: search_library                      │
│  GET  /specs/:id                   get_spec, get_diff                  │
│  POST /specs/:id/generate          parse_document                      │
│  POST /specs/:id/diff              list_sections                       │
│  POST /specs/:id/merge    resources: specr://specs/{id} (Markdown)    │
│                                    specr://library/{div}/{sec}         │
│            │                                │                          │
│            └────────────┬───────────────────┘                          │
│                         │  shared service layer                        │
│  ┌──────────────┐  ┌────┴─────────┐  ┌──────────────┐                │
│  │   Parser     │  │  Merge       │  │  Generator   │                │
│  │              │  │  Engine      │  │              │                │
│  │ .SEC → AST   │  │              │  │  AST → DOCX  │                │
│  │ DOCX → AST   │  │ 3-way diff   │  │  AST → MD    │                │
│  │  (5-signal   │  │ conflict det │  │  w/ content  │                │
│  │  inference)  │  │ merge resol  │  │  controls    │                │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                │
│         │                 │                 │                         │
│         └─────────────────┼─────────────────┘                         │
│                           │                                           │
│                    ┌──────▼──────┐                                    │
│                    │  AST Layer  │                                    │
│                    │  CsiNode    │                                    │
│                    │  CsiTree    │                                    │
│                    └──────┬──────┘                                    │
│                           │                                           │
│                    ┌──────▼──────┐                                    │
│                    │ PostgreSQL  │                                    │
│                    │ paragraphs  │                                    │
│                    │ specs       │                                    │
│                    │ versions    │                                    │
│                    └─────────────┘                                    │
└──────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                        ▲
        │ DOCX/.SEC upload   │ Revit add-in (Ph. 4)   │ Claude/MCP client
        │ (multipart/REST)   │ C#/.NET direct calls   │ (Ph. 2+, ADR-010)
```

### Data Flow: Parse

```
DOCX upload
    ↓
JSZip: extract document.xml, numbering.xml, styles.xml
    ↓
numbering.ts: build abstractNum → num → pStyle linkage map
    ↓
styles.ts:    build basedOn chains, identify numPr-carrying styles
    ↓
inference.ts: walk flat paragraph sequence
              combine 5 signals → assign parent/child relationships
    ↓
Canonical CSI AST (CsiTree with CsiNode hierarchy)
    ↓
PostgreSQL: insert spec + paragraph rows with parent_id, ilvl, version
    ↓
Return spec ID + summary
```

### Data Flow: Generate

```
GET /specs/:id from PostgreSQL
    ↓
Reconstruct CsiTree from paragraph rows (recursive CTE → tree)
    ↓
generator/numbering.ts: assign CSI numbering (PART 1, 1.1, A., 1., a., 1), a))
    ↓
generator/controls.ts: wrap each paragraph in w:sdt with UUID tag
    ↓
dolanmiu/docx: build DOCX with multilevel list definition
    ↓
Return DOCX buffer
```

### Data Flow: Round-Trip Merge

```
Client: POST /specs/:id/diff  (upload edited DOCX)
    ↓
Parse edited DOCX → new AST
    ↓
Match paragraphs by UUID tag (content control lookup)
    ↓
3-way diff: base_version (DB) + theirs (edited DOCX) + ours (current DB)
    ↓
Return diff: added[], modified[], deleted[], conflicts[]
    ↓
Client: POST /specs/:id/merge  (send accepted change IDs)
    ↓
Apply accepted changes to paragraph rows, bump base_version
    ↓
Return updated spec summary
```

## The 5-Signal Inference Engine

The core technical challenge of SpecR. DOCX files store paragraphs flat — hierarchy must be inferred. No single signal is reliable across all firms and documents. The engine combines five signals with weighted confidence:

| Signal | Source | Reliability |
|--------|--------|-------------|
| 1. Numbering XML | `numbering.xml` abstractNum→num→pStyle map | Highest — what Word actually respects |
| 2. Style chain | `styles.xml` basedOn traversal + numPr identification | High for clean documents |
| 3. Document order | ilvl transitions in paragraph sequence | Medium — always present |
| 4. Text content | Regex for leading numbering patterns ("A.", "1.", "PART 1") | Medium — catches hardcoded numbering |
| 5. Indentation | Left indent follows CSI staircase (~576 twips/0.4" per level) | Low — fallback only |

Algorithm is a port of Clippit's `ListItemRetriever` from C#, extended with signals 4 and 5 for real-world messy documents. Reference: `docs/research-executive-summary.md` § "Why Just Build Adapters Won't Work".

## CSI Numbering Standard

Universal across all spec sources — the one thing you can count on:

| Level | CSI Role | ARCAT ilvl | MASTERSPEC ilvl | UFGS XML | Format |
|-------|----------|------------|-----------------|----------|--------|
| Part | Part heading | 0 | 0 | `<PRT>` | `PART 1 - GENERAL` |
| Article | Section heading | 1 | 3 | `<SPT>` | `1.1 REFERENCES` |
| PR1 | First tier | 2 | 4 | `<TXT>` depth 1 | `A. text` |
| PR2 | Second tier | 3 | 5 | `<TXT>` depth 2 | `1. text` |
| PR3 | Third tier | 4 | 6 | `<TXT>` depth 3 | `a. text` |
| PR4 | Fourth tier | 5 | 7 | `<TXT>` depth 4 | `1) text` |
| PR5 | Fifth tier | 6 | 8 | `<TXT>` depth 5 | `a) text` |

Note: MASTERSPEC reserves ilvl 1-2 for Schedule/PDS (rarely used) — so the same logical CSI Article level maps to different ilvl values depending on which template authored the document. The inference engine normalizes this.

## Canonical CSI AST

Internal representation shared by all modules. Not OOXML. Renders to: DOCX, JSON, Markdown (Phase 6), HTML.

```typescript
type NodeType =
  | 'spec'        // root
  | 'part'        // PART 1 - GENERAL
  | 'article'     // 1.1 REFERENCES
  | 'pr1'         // A. text
  | 'pr2'         // 1. text
  | 'pr3'         // a. text
  | 'pr4'         // 1) text
  | 'pr5'         // a) text
  | 'note'        // specifier note (hidden in output)
  | 'continuation' // unnumbered continuation paragraph

interface CsiNode {
  id: string           // UUID — stable across round-trips
  type: NodeType
  text: string         // plain text content (numbers stripped)
  children: CsiNode[]
  meta: {
    vanish?: boolean   // specifier note (CMT / ARCATnote / NTE)
    source?: 'ufgs' | 'arcat' | 'masterspec' | 'unknown'
    revitParam?: string // Revit parameter binding (Phase 4)
    baseVersion?: number // for 3-way merge
  }
}

interface CsiTree {
  id: string           // spec ID
  section: string      // CSI section number, e.g. "27 21 00"
  title: string
  parts: CsiNode[]     // root-level Part nodes
}
```

## API Design (MVP)

All responses follow `ApiResponse<T>`:
```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  meta?: { total: number; page: number; limit: number }
}
```

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/parse` | multipart: `file` (.docx or .sec) | `{ specId, section, title, nodeCount }` |
| GET | `/specs/:id` | — | `CsiTree` |
| PATCH | `/specs/:id` | `{ title?, section? }` | `{ specId, title, section }` |
| POST | `/specs/:id/generate` | `{ templateId? }` | DOCX buffer (octet-stream) |
| POST | `/specs/:id/diff` | multipart: `file` (edited .docx) | `{ added[], modified[], deleted[], conflicts[] }` |
| POST | `/specs/:id/merge` | `{ accept: string[] }` (UUID list) | `{ applied: number, rejected: number }` |

## Database Schema (Overview)

```sql
-- Specs
CREATE TABLE specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section VARCHAR(20),  -- "27 21 00"
  title TEXT,
  source VARCHAR(20),   -- 'ufgs' | 'arcat' | 'masterspec' | 'unknown'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Paragraph tree (adjacency list — recursive CTEs for traversal)
CREATE TABLE paragraphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id UUID REFERENCES specs(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES paragraphs(id),
  node_type VARCHAR(20),
  text TEXT,
  position INTEGER,      -- sibling order
  vanish BOOLEAN DEFAULT false,
  revit_param TEXT,
  base_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Version snapshots for 3-way merge
CREATE TABLE paragraph_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paragraph_id UUID REFERENCES paragraphs(id),
  version INTEGER,
  text TEXT,
  node_type VARCHAR(20),
  snapshot_at TIMESTAMPTZ DEFAULT now()
);
```

## Phased Delivery

### Phase 0: Foundation (Weeks 1–2)
- Project scaffolding (TypeScript, Express, PostgreSQL, ESLint, Prettier, Zod)
- CSI division/section reference data seeded to DB
- Paragraph tree schema + migrations
- Basic CRUD API (`GET /specs/:id`, `PATCH /specs/:id`)
- CI pipeline (lint + test + build + LOC check)

### Phase 1: Parser (Weeks 3–6)
- UFGS .SEC parser: SpecsIntact XML → canonical AST → PostgreSQL
- DOCX numbering.xml analyzer (abstractNum → num → pStyle map)
- DOCX styles.xml analyzer (basedOn chains, numPr-carrying styles)
- 5-signal hierarchy inference engine
- `POST /parse` endpoint
- Test against ARCAT fixtures (machine-generated, cleanest) first, MASTERSPEC second

### Phase 2: Generator + MCP Foundation (Weeks 5–7, overlaps Phase 1)
- AST → DOCX with dolanmiu/docx
- AST → Markdown renderer (prerequisite for MCP resources — ADR-008/010)
- CSI multilevel numbering engine
- Content control UUID injection (`w:sdt` wrapping)
- `POST /specs/:id/generate` endpoint
- MCP server scaffold: `search_library`, `get_spec`, `list_sections` tools
- MCP resources: `specr://specs/{id}` (Markdown), `specr://library/{div}/{sec}`
- Round-trip smoke test: generate DOCX → open in Word → verify numbering

### Phase 3: Merge Engine (Weeks 7–9)
- UUID-based paragraph matching across round-trips
- 3-way diff algorithm (base + theirs + ours)
- Conflict detection
- `POST /specs/:id/diff` and `POST /specs/:id/merge` endpoints
- End-to-end test: parse → generate → manually edit → diff → merge → verify

### Phase 4: Revit Integration (Weeks 10–12)
- Revit parameter → CSI paragraph mapping schema
- Revit add-in (C#/.NET) calling SpecR API directly
- Part 2 auto-population from Revit model data
- Revit change detection → show spec diffs

### Phase 5: Web UI (Weeks 12–16)
- Spec editor (tree view, inline editing)
- Diff/merge review interface
- Firm library management
- Style template configuration
- User management + multi-firm support

### Phase 6: Scale (Ongoing)
- MCP prompts: `review_spec`, `suggest_paragraphs` (AI-assisted spec writing workflows)
- Autodesk Platform Services (APS/Forge) cloud integration
- Full-text search across paragraph libraries
- MCP tool: `parse_document` (upload DOCX/SEC directly from MCP client)

## File Structure

```
specr/
├── src/                         # All TypeScript source
│   ├── index.ts                 # Entry: Express, env validation, graceful shutdown
│   ├── mcp/
│   │   ├── server.ts            # MCP server entry (stdio/SSE, @modelcontextprotocol/sdk)
│   │   ├── tools.ts             # Tool definitions: search_library, get_spec, get_diff, etc.
│   │   └── resources.ts         # Resource handlers: specr://specs/{id}, specr://library/...
│   ├── api/
│   ├── parser/
│   ├── generator/
│   │   └── markdown.ts          # AST → Markdown renderer (used by MCP resources + Phase 6)
│   ├── merge/
│   ├── db/
│   ├── ast/
│   └── lib/
├── tests/
│   ├── fixtures/                # .SEC and .docx test files (binary, gitlfs candidate)
│   ├── unit/                    # Unit tests — no DB, no I/O
│   └── integration/             # Integration tests — require PostgreSQL service
├── docs/
│   ├── adr/                     # Architecture Decision Records
│   └── references/              # UFGS .SEC corpus + README for copyrighted sources
├── .github/
│   ├── workflows/
│   │   ├── ci.yml               # Lint, test, build, LOC check on PR
│   │   ├── release.yml          # Audit, version check, AI notes, release on tag
│   │   └── codeql.yml           # Weekly security scan
│   └── dependabot.yml           # Weekly npm + Actions updates
├── openapi.yaml                 # OpenAPI 3.1 spec — authoritative API contract
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── .eslintrc.json
├── .prettierrc
├── .env.example
├── docker-compose.yml           # PostgreSQL for local dev + integration tests
├── ARCHITECTURE.md              # This file
├── CLAUDE.md                    # Dev instructions for agents + contributors
├── LICENSE                      # TBD — open source
└── README.md
```

## Key Dependencies

```json
{
  "dependencies": {
    "express": "^5",
    "zod": "^3",
    "docx": "^9",
    "jszip": "^3",
    "fast-xml-parser": "^5",
    "pg": "^8",
    "pino": "^9",
    "multer": "^1",
    "uuid": "^11",
    "@modelcontextprotocol/sdk": "^1"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^22",
    "@types/express": "^5",
    "@types/pg": "^8",
    "@types/multer": "^1",
    "@types/uuid": "^10",
    "vitest": "^3",
    "eslint": "^9",
    "@typescript-eslint/eslint-plugin": "^8",
    "@typescript-eslint/parser": "^8",
    "eslint-plugin-sonarjs": "^3",
    "prettier": "^3",
    "ts-node-dev": "^2",
    "depcheck": "^1"
  }
}
```

## Reference Materials

### Specifications Analyzed
- `docs/references/UFGS/` — 666 .SEC files (SpecsIntact XML), 31 divisions, public domain
- ARCAT — 23 DOCX files (machine-generated, cleanest). See `docs/references/ARCAT/README.md`.
- CPI/MASTERSPEC — 6 DOCX files (MASTERSPEC template). See `docs/references/MANUFACTURER_CPI/README.md`.

### Key Libraries
- dolanmiu/docx (TS, MIT): DOCX generation
- Clippit (C#, MIT): Reference implementation for `ListItemRetriever` — hierarchy inference algorithm to port
- docx4j (Java, Apache 2.0): Reference for ECMA-376 style cascade resolution
- officeParser (TS, MIT): Reference for partial OOXML parsing approach

### OOXML Specifications
- ECMA-376 5th edition: https://ecma-international.org/publications-and-standards/standards/ecma-376/
- Style hierarchy (§17.7.2): https://ooxml.info/docs/17/17.7/17.7.2/

### Full Research
- `docs/research-executive-summary.md` — complete landscape analysis, OOXML deep dive, format comparisons, open questions, risks
