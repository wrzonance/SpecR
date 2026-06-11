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
8. **Git-native versioning (future).** Once specs are serializable to pure text (JSON, Markdown, or SEC-XML), git becomes the natural version control layer — branching for master template, per-client template, and per-project tiers; commits for audit history; PRs for redline review. DOCX is an opaque binary and cannot participate. The canonical AST is the prerequisite: text-serializable AST unlocks direct GitHub/GitLab integration as a first-class feature. See ADR-011.

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
│  REST API (Express)         MCP (Streamable HTTP, same process)        │
│  ─────────────────          ────────────────────────────────           │
│  POST /parse                POST /mcp  ← stateless per-request        │
│  GET  /specs/:id            GET  /mcp  (405 stub)                     │
│  POST /specs/:id/generate   DELETE /mcp (405 stub)                    │
│  POST /specs/:id/diff       tools: search_library, get_spec           │
│  POST /specs/:id/merge             list_sections                       │
│                             resources: specr://specs/{id} (Markdown)  │
│                                       specr://sections                 │
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

| Level | CSI Role | ARCAT ilvl | CPI ilvl | UFGS XML | Format |
|-------|----------|------------|-----------------|----------|--------|
| Part | Part heading | 0 | 0 | `<PRT>` | `PART 1 - GENERAL` |
| Article | Section heading | 1 | 3 | `<SPT>` | `1.1 REFERENCES` |
| PR1 | First tier | 2 | 4 | `<TXT>` depth 1 | `A. text` |
| PR2 | Second tier | 3 | 5 | `<TXT>` depth 2 | `1. text` |
| PR3 | Third tier | 4 | 6 | `<TXT>` depth 3 | `a. text` |
| PR4 | Fourth tier | 5 | 7 | `<TXT>` depth 4 | `1) text` |
| PR5 | Fifth tier | 6 | 8 | `<TXT>` depth 5 | `a) text` |

Note: CPI files reserve ilvl 1-2 for Schedule/PDS (rarely used) — so the same logical CSI Article level maps to different ilvl values depending on which template authored the document. The inference engine normalizes this.

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
    source?: 'ufgs' | 'arcat' | 'cpi' | 'unknown'
    revitParam?: string // Revit parameter binding (Phase 4)
    baseVersion?: number // for 3-way merge
  }
}

interface CsiTree {
  id: string           // spec ID
  section: string      // CSI section number, e.g. "27 21 00", "26 00 13.10", "01 32 01.00 10"
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
| POST | `/parse` | multipart: `file` (.docx or .sec), `section?`, `title?` | `202 { jobId }` — async; poll `GET /parse/jobs/:jobId` for result |
| GET | `/parse/jobs/:jobId` | — | `{ jobId, status, progress, result?, error? }` |
| GET | `/specs/:id` | — | `CsiTree` |
| PATCH | `/specs/:id` | `{ title?, section? }` | `{ specId, title, section }` |
| POST | `/specs/:id/generate` | `{ templateId? }` | DOCX buffer (octet-stream) |
| POST | `/specs/:id/diff` | multipart: `file` (edited .docx) | `{ added[], modified[], deleted[], conflicts[] }` |
| POST | `/specs/:id/merge` | `{ accept: string[] }` (UUID list) | `{ applied: number, rejected: number }` |
| POST | `/mcp` | MCP JSON-RPC request | MCP JSON-RPC response (Streamable HTTP transport) |
| GET | `/mcp` | — | `405 Method Not Allowed` |
| DELETE | `/mcp` | — | `405 Method Not Allowed` |

## Database Schema (Overview)

```sql
-- Specs
CREATE TABLE specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section VARCHAR(20),  -- "27 21 00" | "26 00 13.10" | "01 32 01.00 10" (expanded shape, ADR-020)
  title TEXT,
  source VARCHAR(20),   -- 'ufgs' | 'arcat' | 'cpi' | 'unknown'
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

-- Projects own a TOC (ordered set of spec sections)
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- TOC junction: which specs belong to which project, in what order
CREATE TABLE project_specs (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  spec_id    UUID REFERENCES specs(id)    ON DELETE RESTRICT,
  position   INTEGER NOT NULL,            -- TOC display order
  added_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, spec_id)
);

-- Style templates: per-firm DOCX rendering rules
-- (Phase 2c-i — schema only; generator wiring lands in #32)
CREATE TABLE style_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,         -- 'UFGS-Default', 'Acme-Firm', ...
  owner TEXT,                        -- NULL for built-in templates
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-NodeType style rules (one row per node_type per template)
CREATE TABLE style_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES style_templates(id) ON DELETE CASCADE,
  node_type VARCHAR(20) NOT NULL,    -- 'part' | 'article' | 'pr1'..'pr5'
  font_family TEXT,
  font_size_half_pt INTEGER,         -- OOXML native unit (20 = 10pt)
  bold BOOLEAN NOT NULL DEFAULT false,
  caps BOOLEAN NOT NULL DEFAULT false,
  indent_twips INTEGER,              -- OOXML native unit (1440 twips = 1in)
  space_before_twips INTEGER,
  space_after_twips INTEGER,
  numbering_format TEXT,             -- 'PART %1 -', '%1.%2', '%3.', ...
  UNIQUE (template_id, node_type)
);

-- Cross-references extracted at parse time
-- target_spec_id resolved lazily (NULL = unresolved or broken)
CREATE TABLE spec_references (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_spec_id      UUID REFERENCES specs(id)      ON DELETE CASCADE,
  source_paragraph_id UUID REFERENCES paragraphs(id) ON DELETE CASCADE,
  target_type         VARCHAR(20) NOT NULL,  -- 'section' | 'paragraph' | 'standard'
  target_spec_section VARCHAR(20),           -- "09 91 00" / "26 00 13.10" — for section refs
  target_spec_id      UUID REFERENCES specs(id)      ON DELETE SET NULL,
  target_paragraph_id UUID REFERENCES paragraphs(id) ON DELETE SET NULL,
  standard_code       TEXT,                  -- "ASTM C150" — for standard refs
  reference_text      TEXT NOT NULL,         -- verbatim text from source paragraph
  is_broken           BOOLEAN DEFAULT false, -- set true when target removed
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- Revit parameter mappings (Phase 4a). One Revit family instance fans out to
-- many paragraphs across many specs. The natural key uses NULLS NOT DISTINCT
-- (PG 15+) so family-instance-level rows (NULL component_role) collide
-- correctly under idempotent upsert. spec_id is intentionally NOT denormalized
-- here — derive via paragraphs.spec_id when filtering by spec.
CREATE TABLE revit_parameter_mappings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paragraph_id         UUID NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  revit_instance_id    TEXT NOT NULL,       -- Revit element GUID, stable per element
  revit_component_role TEXT,                -- 'faceplate' | 'jack' | 'conduit' | ...
                                            -- NULL = family-instance-level param
  revit_param          TEXT NOT NULL,       -- e.g. 'Manufacturer', 'PortCount'
  direction            VARCHAR(20) NOT NULL DEFAULT 'to_spec'
    CHECK (direction IN ('to_spec','to_revit','bidirectional','spec_only')),
  transform_type       VARCHAR(20) NOT NULL
    CHECK (transform_type IN ('replace','placeholder','append','prepend')),
  transform_config     JSONB,               -- Zod-validated in app layer (#47)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT
    (paragraph_id, revit_instance_id, revit_component_role, revit_param)
);
```

### Composite Revit identity

A single Revit family instance (e.g., "Data Outlet A") is rarely one parameter source — it contains multiple sub-components (faceplate, jack, conduit, backbox, cable), each with its own Revit parameters. The schema treats `(revit_instance_id, revit_component_role, revit_param)` as the source identity, with `revit_component_role = NULL` reserved for parameters defined at the family-instance level itself.

That same instance also fans out across **multiple specs** — a Data Outlet touches both Division 26 (pathways) and Division 27 (telecommunications). One Revit instance ID therefore appears on many `paragraph_id`s in different specs, retrieved via `getMappingsByInstance(...)`.

### Direction enum reserves bidirectional sync

`direction` enumerates four edge directions:

| Value | Meaning | Phase |
|-------|---------|-------|
| `to_spec` (default) | Revit value populates the spec paragraph | 4a — only direction implemented today |
| `to_revit` | Spec-authoritative value pushed back to Revit | reserved for #85 |
| `bidirectional` | Mutual sync — diff resolution required | reserved for #85 |
| `spec_only` | Spec is authoritative; Revit is advisory / read-only | reserved for #85 |

The check constraint blocks invalid values now so the write path in #47 can rely on the enum surface without re-validating.

### Deferred work building on this schema

| Concern | Tracked by |
|---------|-----------|
| `PATCH /specs/:id/paragraphs/:nodeId` endpoint that consumes mappings | #47 |
| Revit add-in (C#/.NET) scaffold that writes mappings via the REST API | #48 |
| Family-category → required MasterFormat sections registry + project preflight | #82 |
| Family-type-level mappings (`revit_family_type_id`) | #83 |
| Multi-Revit-model support (`revit_model_id`) | #84 |
| Bidirectional sync write path (`to_revit` / `bidirectional` / `spec_only`) | #85 |

## Cross-Reference Awareness

Specs are not isolated documents — they form a web of dependencies within a project. SpecR must model and enforce this.

### Reference types extracted at parse time

| Type | Example | Source in .SEC |
|------|---------|----------------|
| Section | "See Section 09 91 00" | Text regex + `<REF>` blocks |
| Standard | "ASTM C150", "UFC 3-580-01" | `<REF>` / `<RID>` elements |
| Paragraph | "See paragraph 1.1 REFERENCES" | Text regex |

All references land in `spec_references` at parse time. `target_spec_id` is resolved against the library; unresolved refs start with `is_broken = false` (target may not be loaded yet).

### Two operation contexts — different cascade behaviors

**TOC edit (intentional):** Spec manager edits the project table of contents. Removing a section is a deliberate act — no warning prompt. System auto-cascades: `spec_references` rows pointing to the removed section are deleted; surviving paragraphs that referenced it have their `is_broken` flag set to `true`. Re-adding the section restores the resolved `target_spec_id` and clears `is_broken`.

**In-flight paragraph edit:** Granular changes during spec authoring. Broken references are flagged and surfaced via `GET /projects/:id/references/broken`. Spec writer resolves manually. 3-way merge history provides recovery if content was deleted by mistake.

### Revit sync (Phase 4 hook point)

When a Revit model sync pushes new Family Instance data, the system will surface:
- Proposed Part 2 paragraph additions (new equipment → new product paragraphs)
- Candidate new spec sections (new Revit category with no matching spec in TOC)

These appear in the web dashboard as pending additions — not auto-applied. The spec manager approves or rejects. The `spec_references` model supports this: a Revit-sourced paragraph can carry references the same way parsed content does.

## Phased Delivery

### Phase 0: Foundation (Weeks 1–2)
- Project scaffolding (TypeScript, Express, PostgreSQL, ESLint, Prettier, Zod)
- CSI division/section reference data seeded to DB
- Paragraph tree schema + migrations
- Basic CRUD API (`GET /specs/:id`, `PATCH /specs/:id`)
- CI pipeline (lint + test + build + LOC check)

### Phase 1: Parser (Weeks 3–6)

Sub-MVP 1a — UFGS parser + cross-reference model:
- `projects` / `project_specs` / `spec_references` DB migrations (schema only, no API)
- UFGS .SEC parser: SpecsIntact XML → canonical AST → PostgreSQL
- Cross-reference extraction at parse time → `spec_references` table
- Bulk corpus loader: all 666 UFGS .SEC files → library namespace

Sub-MVP 1b — Project + TOC API:
- `POST /projects`, `GET /projects/:id`
- TOC management: add/remove spec sections from a project
- TOC-level cascade: removing a section auto-purges dangling `spec_references`, marks broken refs on remaining sections
- `GET /projects/:id/references/broken` — surface broken refs for spec writer review

Sub-MVP 1c-i — DOCX numbering + style analyzers (complete, PR #17):
- DOCX `numbering.xml` analyzer (abstractNum → num → pStyle map, articleIlvl auto-detection)
- DOCX `styles.xml` analyzer (basedOn chains, numPr-carrying styles, Clippit numId=0 chain-stop)
- Intermediate types: `NumberingMap`, `StyleMap`, `DocxParagraph`
- Extraction rule constants (`ARCAT_ILVL_MAP`, `CPI_ILVL_MAP`, `SECTION_REF_RULES`) as typed MCP-surfaceable data

Sub-MVP 1c-ii — DOCX hierarchy inference + `POST /parse` (issue #12):
- `document.ts`: extract `DocxParagraph[]` from `word/document.xml` (JSZip + fast-xml-parser)
- `heuristics.ts`: signal 4 (text regex, anchored to `^`, min-length guard) + signal 5 (indentation / 576 twips)
- `inference.ts`: two-pass engine — pass 1 signal priority chain (1→5) with conflict logging; pass 2 stack-based tree construction
- `index.ts`: DOCX orchestrator with `onProgress` callback for async job tracking
- `POST /parse` + `GET /parse/jobs/:jobId`: async job pattern (202 + poll) for progress surfacing in Phase 5 UI
- Test against ARCAT fixtures first (machine-generated, cleanest), CPI second

Sub-MVP 1c-iii — DOCX cross-reference extraction (follow-up):
- Run `SECTION_REF_RULES` regex over DOCX paragraph text → `spec_references` table
- Parity with .SEC parser cross-reference extraction

### Phase 2: Generator + MCP Foundation (Weeks 5–7, overlaps Phase 1)

**Phase 2a — MCP server + Markdown renderer:**
- MCP server integrated into Express via Streamable HTTP (`POST /mcp`, `GET /mcp` 405 stub, `DELETE /mcp` 405 stub) — stateless `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`, one `McpServer` instance per request. Supersedes ADR-010's original stdio/SSE stance; see ADR-010 Decision Update.
- `src/generator/markdown.ts`: pure function `renderMarkdown(CsiTree): string` + `getLabel(NodeType, index, partNumber?)`. Vanish/note nodes render as `> **[NOTE]**` blockquotes (not hidden) in MCP output. Shared with future DOCX generator and Phase 6.
- MCP tools (read-only Phase 2a scope): `search_library(query, division?, limit?)`, `get_spec(specId)` → `{ tree: CsiTree, references: SpecReference[] }` (each reference includes `isResolved: boolean`), `list_sections(division?)`
- MCP resources: `specr://specs/{id}` (Markdown), `specr://sections` (Markdown table)
- Auth: none for Phase 2. Auth hook comment in `src/mcp/server.ts`; auth added in same PR as REST auth (future).
- **Stateful session upgrade path (Phase 5+):** change `sessionIdGenerator: undefined` → `sessionIdGenerator: () => randomUUID()` + session Map in the route handler. Tool/resource definitions unchanged.
- Deferred to later phases: `get_paragraph`, `parse_document`, write tools, stateful sessions, MCP prompts

**Phase 2b — Core DOCX generator:** ✅ Complete (PR #26, PR #28)

- **2b-i** ✅ — `generateDocx()` + `buildCsiNumberingConfig()`, 7-level CSI multilevel numbering, `POST /specs/:id/generate` endpoint (PR #26)
- **2b-ii** ✅ — `wrapWithControl()`, `SdtBlock extends FileChild`, `specr-uuid-<CsiNode.id>` tags in `w:sdtPr` as round-trip merge anchors per ADR-004 (PR #28). Uses `StringValueElement('w:tag', ...)` for idiomatic docx-native attribute injection. Title paragraph intentionally bare — synthetic, no DB id.
- **2b-iii** ✅ — `get_paragraph(paragraphId)` → `{ node, ancestors[] }` ancestor chain via recursive CTE; `parse_document(filename, contentBase64)` → ingest DOCX/SEC via MCP with base64 encoding; `generate_docx(specId)` → on-demand base64 DOCX. (closes #29)

**Phase 2c — Firm style template engine (issue #20):**
- `style_templates` + `style_rules` DB tables; default CSI styles seeded at migration
- Generator accepts `templateId?` (already in `POST /specs/:id/generate` body) — wired through to numbering + controls
- Template import API: `POST /templates`, `POST /templates/:id/rules`
- Prerequisite for Phase 5 live preview: generate DOCX → blob → client render

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
- DOCX cache layer — pre-generate + store DOCX on spec write, invalidate on paragraph change, locking to prevent stale reads (see issue #52)

## File Structure

```
specr/
├── src/                         # All TypeScript source
│   ├── index.ts                 # Entry: Express, env validation, graceful shutdown
│   ├── mcp/
│   │   ├── server.ts            # registerMcpRoutes(app) — Streamable HTTP, stateless per-request McpServer
│   │   ├── tools.ts             # registerTools(server): search_library, get_spec, list_sections
│   │   └── resources.ts         # registerResources(server): specr://specs/{id}, specr://sections
│   ├── api/
│   ├── parser/
│   ├── generator/
│   │   └── markdown.ts          # AST → Markdown renderer (used by MCP resources + Phase 6)
│   ├── merge/                   # Phase 3a — pure algorithm + DOCX extractor; base side fed by db/queries/versions (wired in #35)
│   │   ├── error.ts             # MergeError
│   │   ├── types.ts             # ExtractResult, DiffResult, TrackChangeRecord (ParagraphSnapshot lives in ast/)
│   │   ├── extract.ts           # DOCX buffer → uuid→text map via w:sdt specr-uuid anchors (virtual-accept track changes)
│   │   ├── diff.ts              # computeDiff — pure git-style 3-way diff (base/ours/theirs)
│   │   └── index.ts             # barrel — public surface (MergeError, computeDiff, extractContentControls, types)
│   ├── db/
│   ├── ast/
│   └── lib/
│       ├── decode-text.ts        # Buffer → UTF-8 string, encoding-agnostic (chardet + iconv-lite)
│       ├── errors.ts             # SpecrError base class
│       ├── jobs.ts               # In-memory async job store (parse progress)
│       ├── env.ts                # Zod env validation — exits process on invalid config
│       └── logger.ts             # Structured logging (pino)
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
    "@modelcontextprotocol/sdk": "^1",
    "chardet": "^2",
    "iconv-lite": "^0.6"
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
- Chatsworth Products Inc. (CPI) — 6 DOCX files (telecom equipment manufacturer specs implementing CSI MasterFormat). See `docs/references/MANUFACTURER_CPI/README.md`.

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
