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
| PDF text layer | **unpdf** (primary) + **pdfjs-dist** (fallback) | Extract the PDF text layer; drop to the low-level `pdfjs-dist` API for malformed files. Feeds the text-inference path (ADR-034). |
| PDF OCR | **tesseract.js** + **@napi-rs/canvas** | WASM OCR for scanned/no-text-layer pages, rasterized via prebuilt native canvas. Bounded, offline-safe worker init (ADR-039). |
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
│  POST /parse                POST /mcp  ← stateless or session         │
│  GET  /specs/:id            GET  /mcp  (405 stub)                     │
│  POST /specs/:id/generate   DELETE /mcp (terminates a session)        │
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
│                    │ libraries   │                                    │
│                    │ paragraphs  │                                    │
│                    │ specs       │                                    │
│                    │ division    │                                    │
│                    │ general     │                                    │
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

`.SEC`, `.txt`, and `.pdf` uploads enter the same pipeline through format
adapters that converge on the AST. PDF (ADR-034) extracts the text layer via
`unpdf` (falling back to `pdfjs-dist`); pages with no usable text layer are
rasterized and OCR'd with `tesseract.js`, with font-encoding recovery, then fed
to the text-based inference path. OCR worker init is time-bounded and offline-safe
so scanned PDFs degrade with warnings rather than hang (ADR-039). A parse may also
apply a saved structural numbering profile as a deterministic override instead of
the default 5-signal inference (`numberingProfileId`, #299).

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
| PR6 | Sixth tier (deep extension) | 7 | 9 | `<TXT>` depth 6 | `1) text` |
| PR7 | Seventh tier (deep extension) | 8 | 10 | `<TXT>` depth 7 | `a) text` |

Note: CPI files reserve ilvl 1-2 for Schedule/PDS (rarely used) — so the same logical CSI Article level maps to different ilvl values depending on which template authored the document. The inference engine normalizes this.

Note: CSI does not define PR6/PR7 labels. SpecR caps DOCX output at Word's nine
numbering levels and repeats the final CSI paren pair (`1)` / `a)`) at deeper
indent levels. See ADR-027.

**Conflict persistence (#56):** when multiple signals fire and disagree, the losing signals are recorded as `{ signal, reportedIlvl, reportedNodeType }` and persisted to `paragraphs.conflicts` (JSONB, `NOT NULL DEFAULT '[]'`). They surface as `meta.conflicts` on tree nodes (`get_spec` MCP tool and the shared `getSpecTree` query) and as a top-level `conflicts` field on the node and each ancestor returned by the `get_paragraph` MCP tool — empty arrays are omitted on the wire. This makes inference ambiguity transparent to agents and the future UI instead of silently picking a winner.

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
  | 'pr6'         // deep extension: 1) text
  | 'pr7'         // deep extension: a) text
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
    articleRole?: string // derived Article role — 'related-sections' | 'references' | 'submittals' | … (ADR-033, not persisted)
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
| POST | `/parse` | multipart: `file` (.docx/.sec/.txt/.pdf), `section?`, `title?`, `numberingProfileId?` | `202 { jobId }` — async; poll `GET /parse/jobs/:jobId` for result |
| GET | `/parse/jobs/:jobId` | — | `{ jobId, status, progress, result?, error? }` |
| GET | `/specs/:id` | — | `CsiTree` |
| PATCH | `/specs/:id` | `{ title?, section? }` | `{ specId, title, section }` |
| POST | `/specs/:id/generate` | `{ templateId? }` | DOCX buffer (octet-stream) |
| POST | `/specs/:id/diff` | multipart: `file` (edited .docx) | `{ added[], modified[], deleted[], conflicts[] }` |
| POST | `/specs/:id/merge` | `{ accept: string[], diff: DiffResult }` | `{ applied: number, rejected: number }` |
| GET | `/libraries/:libraryId/divisions/:division/general-spec` | — | `DivisionGeneralSpecResult` |
| PUT | `/libraries/:libraryId/divisions/:division/general-spec` | `{ generalSpecId }` or `{ status: "not_applicable" }` | `DivisionGeneralSpecResult` |
| GET | `/projects/:id/divisions/:division/general-spec` | — | `DivisionGeneralSpecResult` |
| PUT | `/projects/:id/divisions/:division/general-spec` | `{ generalSpecId }` or `{ status: "not_applicable" }` | `DivisionGeneralSpecResult` |
| POST | `/mcp` | MCP JSON-RPC request | MCP JSON-RPC response (Streamable HTTP transport) |
| GET | `/mcp` | — | `405 Method Not Allowed` |
| DELETE | `/mcp` | — | `405 Method Not Allowed` |

The table above is the original MVP surface. `openapi.yaml` is the authoritative,
CI-enforced contract (rendered live at `GET /docs` via Scalar, served raw at
`GET /openapi.yaml`). Endpoint groups added since the MVP:

- **Spec lifecycle:** `DELETE /specs/:id` (soft-withdraw) + `/specs/:id/restore`; advisory locks (`GET/PUT/DELETE /specs/:id/lock`); reversible paragraph removal; single-paragraph `PATCH`.
- **Onboarding & editability:** `PATCH .../editability`, `POST /specs/:id/reclassify`, `POST /specs/:id/finalize` & `/reopen`, `POST .../comments/:index/accept-as-note`, external-content associations, `POST/DELETE /specs/:id/style-source`, numbering-profile assignment.
- **Projects:** `GET /projects` (list), `PATCH /projects/:id` (rename + `sectionNumberFormat`), `DELETE /projects/:id` + `/restore`, `PUT /projects/:id/sources`.
- **Coordination / E&O:** required-sections (project + package), `GET /projects/:id/coordination-report`, `POST /projects/:id/submittal-register`, `GET /specs/:id/open-comments` & `GET /projects/:id/open-comments`.
- **Libraries:** `GET /libraries`, `POST /libraries/clients`, `PATCH /libraries/:id`, `GET /libraries/:id/specs`, async `POST /libraries/:id/import`, convention profiles, numbering profiles.
- **Revisions & templates:** `POST /revisions/:id/generate` (issued/addendum manuals), revision-nomenclature profiles, style-template CRUD + `POST /templates/import`.

## Database Schema (Overview)

```sql
-- Library owners for reference, company, and client masters
CREATE TABLE libraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier VARCHAR(20) NOT NULL,          -- 'reference' | 'company' | 'client'
  name TEXT NOT NULL UNIQUE,
  owner TEXT,
  parent_library_id UUID REFERENCES libraries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Specs
CREATE TABLE specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section VARCHAR(20),  -- "27 21 00" | "26 00 13.10" | "01 32 01.00 10" (expanded shape, ADR-020)
  title TEXT,
  source VARCHAR(20),   -- 'ufgs' | 'arcat' | 'cpi' | 'unknown'
  library_id UUID REFERENCES libraries(id), -- master owner; XOR with project_id
  project_id UUID REFERENCES projects(id),  -- project working-copy owner
  parent_spec_id UUID REFERENCES specs(id), -- copy provenance, not division context
  origin_version INTEGER,
  content_version INTEGER NOT NULL DEFAULT 1,
  origin_meta JSONB,
  onboarding_status TEXT NOT NULL DEFAULT 'active', -- 'review' | 'active' (ADR-022; #139)
  withdrawn_at TIMESTAMPTZ,                          -- NULL = active; soft-withdraw a master (ADR-030)
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
  source_facts JSONB NOT NULL DEFAULT '{}', -- parsed comment/color/choice-token facts (#187)
  classification JSONB,                      -- derived editability classification (ADR-022)
  editability_override JSONB,                -- human override, never merged into classification (ADR-022 D2)
  revit_param TEXT,
  origin_paragraph_id UUID REFERENCES paragraphs(id) ON DELETE SET NULL,
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
  -- section_number_format CHECK IN ('canonical','dots','compact','spaced-compact') (ADR-032)
  section_number_format TEXT NOT NULL DEFAULT 'canonical',
  deleted_at TIMESTAMPTZ,   -- NULL = active; soft-delete (ADR-031)
  deleted_by TEXT,          -- free-text actor recorded at soft-delete
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

-- Ordered source libraries for project copy-on-derive resolution
CREATE TABLE project_sources (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  library_id UUID REFERENCES libraries(id),
  priority INTEGER NOT NULL,
  PRIMARY KEY (project_id, library_id)
);

-- Division-general context, separate from spec copy provenance (ADR-023)
CREATE TABLE division_general_specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id UUID REFERENCES libraries(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  division VARCHAR(2) NOT NULL,
  general_spec_id UUID REFERENCES specs(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,           -- 'resolved' | 'not_applicable'
  detection_method VARCHAR(30) NOT NULL, -- 'exact_section' | 'manual'
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Style templates: per-firm DOCX rendering rules
-- (Phase 2c-i schema; applied by the generator via templateId — issue #32)
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
  node_type VARCHAR(20) NOT NULL,    -- 'part' | 'article' | 'pr1'..'pr7'
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

### Additional tables

Later migrations add these tables (see the migration files and cited ADRs for
column detail):

| Table | Purpose | ADR / PR |
|-------|---------|----------|
| `division_general_specs` | Division-general context, library- and project-scoped | ADR-023 |
| `editing_conventions` | Built-in + library-scoped editability convention profiles | ADR-022 |
| `paragraph_associations` | Paragraph ↔ external document reference links | #242 |
| `required_sections` | Authored required-sections substrate (project + package scope) | ADR-028 |
| `keynotes` | Keynote master table + project-filtered query (**storage only**, no API/render yet) | ADR-016 |
| `header_footer_configs` | Scoped header/footer overrides (**foundation only**, no resolution/render yet) | ADR-017, ADR-040 |
| `numbering_profiles` | Saved structural numbering profiles, library-scoped | #299 |
| `revision_nomenclature_profiles` | Structured revision/addendum naming, built-in + project override | ADR-025 |

Concurrency/versioning also add advisory lock and lifecycle-state storage
(ADR-018). Style storage moved to a JSONB payload on `style_rules` (ADR-021).

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

## Coordination Report / Errors-&-Omissions

`GET /projects/:id/coordination-report` is a read-only, computed report over a
project's TOC, authored intent, and extracted references. It never mutates state;
it returns a discriminated union of `Finding` types plus per-type summary counts.
Findings are backed by `src/db/queries/coordination.ts` and its helpers
(`article-refs.ts`, `umbrella-callouts.ts`, `snippet.ts`) and the
`src/coordination/` and `src/submittals/` modules. The finding vocabulary:

| Finding | Meaning | ADR |
|---------|---------|-----|
| `required_not_present` | Section authored as required but absent from the TOC | ADR-028/029 |
| `present_not_required` | Section in the TOC but not in the required baseline | ADR-028/029 |
| `dangling_ref` | Reference to a section not present (carries `sourceParagraphId` + `snippet`) | #269 |
| `related_listed_not_cited` | Listed in a Related Sections article but never cited in the body | #277 |
| `related_cited_not_listed` | Cited in the body but missing from Related Sections | #277 |
| `standard_cited_not_listed` | Standard cited in body but absent from the References article | #277 |
| `umbrella_not_called_out` | Umbrella section (Div 26/27/28) not cross-called by a subordinate | ADR-037 |
| `implied_related_section` | Advisory: a likely related section inferred by title-keyword match | ADR-035 |
| `product_*` / `submittal_type_*` | Product↔submittal-type gaps from the submittal register | ADR-036 |

The **submittal register** (`POST /projects/:id/submittal-register`) is a related,
product-driven analysis returning the same-shaped findings for selected specs.
Semantic **article-role tagging** (ADR-033) is the substrate several of these
findings build on — see the AST section.

## Deterministic-First: Grounded Data, Not RAG

SpecR's analytical outputs — the coordination / E&O report, submittal register,
3-way spec diff, broken and inbound reference sets, and open-comments report — are
**computed by deterministic endpoints over the structured CSI AST in PostgreSQL**,
not produced by retrieving document text and asking a language model to summarize
it. `GET /projects/:id/coordination-report` runs recursive-CTE queries and typed
finding logic (`src/db/queries/coordination.ts`); `POST /projects/:id/submittal-register`
matches products against submittal types; `POST /specs/:id/diff` matches paragraphs
by UUID content-control anchor. Same input, same findings, every run.

The MCP contract (ADR-044) surfaces each operation as a tool — `coordination_report`,
`submittal_register`, `get_spec_diff`, `get_references`, `open_comments_report` — with
a CI gate that fails if a user-facing REST operation has no corresponding tool (or an
explicit exemption). An agent therefore does not read spec blobs and infer; it calls a
tool and gets computed ground truth.

This is a deliberate division of labor. Producing exact, exhaustive, self-consistent
structured facts is what language models are least reliable at; narrating and
synthesizing facts is what they are good at. SpecR supplies the facts; the agent
composes. And because every paragraph carries a stable UUID — the same anchor the
merge engine round-trips through — every finding traces back to a spec and paragraph
id, so an agent's claims are citable, not merely plausible.

The contrast is with retrieval-augmented generation over document text, where the
output is only as sound as the model's summary of the passages it retrieved. Stanford
(2025) found that even purpose-built, RAG-backed legal-research tools hallucinated on
roughly 17–34% of queries. SpecR keeps the model out of the fact-production path.

## Document Concurrency

Writes are guarded so concurrent editors do not clobber each other (ADR-018).
Paragraph updates are **optimistic** (version-checked); a spec carries an
advisory **lock** (`GET/PUT/DELETE /specs/:id/lock`, acquire/refresh/steal-after-expiry/release);
and specs move through a review/active **lifecycle** (`onboarding_status`), with
issued package revisions frozen as immutable snapshots. The edit-gate and lock
logic live in `src/api/locks.ts`, `src/api/edit-gate-response.ts`, and
`src/db/queries/{locks,edit-gate,revisions}.ts`.

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
- **Stateful sessions (Phase 5h, #45):** `POST /mcp` now also serves optional stateful sessions. An `initialize` with no `mcp-session-id` header mints a session (`sessionIdGenerator: () => randomUUID()`); the session's transport+server pair is kept in a `McpSessionStore` (`src/mcp/sessions.ts`) keyed by the minted id, and reused for later requests carrying that header. `DELETE /mcp` closes and removes a session. Stateless callers (no header) still get a fresh transport per request. Tool/resource definitions unchanged.
- Deferred to later phases: write tools, MCP prompts, GET /mcp SSE streaming

**Phase 2b — Core DOCX generator:** ✅ Complete (PR #26, PR #28)

- **2b-i** ✅ — `generateDocx()` + `buildCsiNumberingConfig()`, 7-level CSI multilevel numbering, `POST /specs/:id/generate` endpoint (PR #26)
- **2b-ii** ✅ — `wrapWithControl()`, `SdtBlock extends FileChild`, `specr-uuid-<CsiNode.id>` tags in `w:sdtPr` as round-trip merge anchors per ADR-004 (PR #28). Uses `StringValueElement('w:tag', ...)` for idiomatic docx-native attribute injection. Title paragraph intentionally bare — synthetic, no DB id.
- **2b-iii** ✅ — `get_paragraph(paragraphId)` → `{ node, ancestors[] }` ancestor chain via recursive CTE; `parse_document(filename, contentBase64)` → ingest DOCX/SEC via MCP with base64 encoding; `generate_docx(specId)` → on-demand base64 DOCX. (closes #29)

**Phase 2c — Firm style template engine (issue #20):** ✅ Complete
- ✅ `style_templates` + `style_rules` DB tables; default CSI styles seeded at migration (PR #87); JSONB `properties` payload per ADR-021 (migration 014)
- ✅ `templateId?` in the `POST /specs/:id/generate` body resolves to template rules and is applied by `generateDocx` — per-NodeType font/spacing/indent on styled paragraphs, `numFmt`/`lvlText`/`start` overrides on the numbering definition. Omitted → seeded `UFGS-Default` (so an explicit default-template request is identical to a bare request); unknown id → 404 (issue #32)
- ✅ Template import API: `POST /templates`, `POST /templates/:id/rules` CRUD (PR #156); `POST /templates/import` DOCX consensus derivation (PR #151)
- ✅ Prerequisite for Phase 5 live preview: generate DOCX → blob → client render

### Phase 3: Merge Engine (Weeks 7–9) — ✅ Complete
- UUID-based paragraph matching across round-trips
- 3-way diff algorithm (base + theirs + ours)
- Conflict detection
- `POST /specs/:id/diff` and `POST /specs/:id/merge` endpoints
- End-to-end test: parse → generate → edit returned DOCX text → diff → merge → verify

### Phase 4: Revit Integration (Weeks 10–12)
- Revit parameter → CSI paragraph mapping schema
- Revit add-in (C#/.NET) calling SpecR API directly — **separate C# solution in `revit-addin/`** (own `dotnet` toolchain, independent of the pnpm/TS build). Phase 4c scaffold: `IExternalApplication` ribbon registration + typed Refit REST client against `openapi.yaml` (`SpecRClient.GetSpecAsync`/`GetHealthAsync`). Targets the Revit 2024 runtime (.NET Framework 4.8). See `revit-addin/README.md`.
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

## Module Boundaries

Each module in `src/` is a self-contained unit: a typed error class, a public API exported from its `index.ts`, no leaked internals. Modules import only from a sibling's `index.ts` barrel — never from its internal files.

`lib/` is the one exception: it is not a module with a public API but a collection of leaf utilities (`errors.ts`, `logger.ts`, `env.ts`, …). It has no barrel — import the file you need directly, e.g. `import { logger } from '../lib/logger.js'`.

```text
parser/    ← knows about AST types; nothing about DB or API
generator/ ← knows about AST types and dolanmiu/docx; nothing else
merge/     ← knows about AST types and DB queries; nothing about parsing
db/        ← knows about AST types and pg; nothing about domain logic
api/       ← orchestrates all modules; owns HTTP concerns only
mcp/       ← imports from db/index, generator/index, parser/index; no api/ internals
lib/       ← format-agnostic utilities (errors, logging, encoding); usable by any module
```

```typescript
// CORRECT — through the barrel
import { parse } from '../parser/index.js'

// WRONG — leaks internal structure
import { buildNumberingMap } from '../parser/docx/numbering.js'
```

## Error Handling — Context Chains

Every error carries the full "why" chain from origin to surface. The pattern:

- One custom error class per module boundary, extending `SpecrError` (`src/lib/errors.ts`): `ParserError`, `GeneratorError`, `MergeError`.
- `cause` chaining at every catch site where the caller adds meaning.
- Zod for all external-input validation (request bodies, env vars, parsed XML/OOXML); chain the `ZodError` as `cause`.

```typescript
// src/lib/errors.ts
export class SpecrError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = this.constructor.name
  }
}

// src/parser/error.ts
export class ParserError extends SpecrError {}

// src/parser/docx/numbering.ts — correct context chaining
function buildNumberingMap(xml: string): NumberingMap {
  try {
    return parseNumberingXml(xml)
  } catch (err) {
    throw new ParserError('failed to build numbering map from numbering.xml', { cause: err })
  }
}

// Resulting chain:
//   ParserError: DOCX parse failed
//   Caused by: ParserError: failed to build numbering map from numbering.xml
//   Caused by: Error: abstractNum id="3" references undefined numId
```

Anti-patterns rejected in review:

```typescript
} catch (_err) { throw new ParserError('failed') }   // swallows context
function parse(input: any): any { ... }              // any across a boundary
const node = map.get(id)!                            // non-null assertion in non-test code
function buildMap(): Record<string, unknown> { ... } // untyped raw boundary
```

**API error surface:** all errors are caught by `src/api/middleware/error.ts` and mapped to `ApiResponse<never>` with the appropriate HTTP status — `ParserError` → 422, `MergeError` (conflict) → 409, unknown → 500. Stack traces never leave the process.

## Complexity Controls (enforced)

ESLint (`eslint.config.js`) — `error` severity, not warnings:

```js
complexity: ['error', 10],
'sonarjs/cognitive-complexity': ['error', 10],
'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
'no-console': 'error',
'@typescript-eslint/no-explicit-any': 'error',
```

Test files (`src/**/*.test.ts`) and `scripts/**/*.ts` relax the line/console caps (see config for the exact carve-outs). TypeScript strict mode plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` (`tsconfig.json`).

## MCP Server

`src/mcp/server.ts` exports `registerMcpRoutes(app: Express)`. `POST /mcp` supports both transport modes. A stateless caller (no `mcp-session-id` header, non-`initialize` body) gets a fresh `McpServer` + stateless `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) per request, disposed on response finish. An `initialize` with no session header mints a stateful session: a transport with `sessionIdGenerator: () => randomUUID()` whose pair is held in an `McpSessionStore` (`src/mcp/sessions.ts`) keyed by the minted id and reused for every later request carrying that `mcp-session-id`. `registerTools(server)` and `registerResources(server)` wire all capabilities in both modes. `GET /mcp` returns 405 (SSE streaming not yet exposed). `DELETE /mcp` terminates the session named by `mcp-session-id` (400 if absent, 404 if unknown, 204 on success).

**Adding a tool** (inside `registerTools(server)` in `src/mcp/tools.ts`):

```typescript
server.registerTool('tool_name', {
  description: 'What this tool does for an AI agent.',
  inputSchema: { param: z.string().describe('param description') },
}, async ({ param }) => {
  try {
    const result = await someQuery(param);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool tool_name failed');
    return { isError: true, content: [{ type: 'text' as const, text: 'Internal error' }] };
  }
});
```

Rules: import DB functions from `../db/index.js` only (no internal query-file imports); use `z.uuid()` (Zod v4), not `z.string().uuid()`; always return `{ isError: true, content: [...] }` on error — never throw from a tool handler; extract handlers if a body exceeds the 50-line `max-lines-per-function` cap.

**Result anchors (`_meta['specr/anchors']`):** the four locate-oriented tools (`search_library`, `get_spec`, `get_references`, `coordination_report`) attach navigation anchors to their result's `_meta` under the key `specr/anchors` — an array of `{ section: string; specId?: string; paragraphId?: string }` derived purely from data already in the result (`src/mcp/anchors.ts`). The text `content` is unchanged, so text-only consumers are unaffected. UI clients (the `web_ui_demo` chat sidebar) use these to highlight the section(s) an answer is about in the active view. Attach with `anchorsMeta(anchors)`, which returns `undefined` for an empty list so no `_meta` is added. `_meta` is MCP's sanctioned channel for implementation metadata, chosen over a full `outputSchema`/`structuredContent` (disproportionate for tools like `get_spec` that return an entire tree).

**Adding a resource:**

```typescript
// Static URI:
server.registerResource('name', 'specr://path', { description: '...', mimeType: 'text/markdown' }, async (uri) => {
  return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: markdownString }] };
});
// Template URI:
server.registerResource('name', new ResourceTemplate('specr://path/{id}', { list: undefined }), { ... }, async (uri, { id }) => { ... });
```

**Stateful sessions (Phase 5h, #45):** implemented via `McpSessionStore` (`src/mcp/sessions.ts`), which owns the `Map<sessionId, { server, transport }>` and the session lifecycle (`createStateful`, `get`, `delete`). The SDK transport binds one session per instance, so a session is one long-lived transport+server pair keyed by the id the transport mints on `initialize`; the store registers/removes itself via the transport's `onsessioninitialized` / `onsessionclosed` callbacks. Tool/resource definitions are unchanged. **Auth hook:** the insertion point is marked in `server.ts`; add `Authorization: Bearer <token>` validation there in the same PR as REST auth.

## Markdown Renderer

`src/generator/markdown.ts` is a pure module (no I/O, no DB), shared between MCP resources and the future DOCX generator.

- `renderMarkdown(tree: CsiTree): string` — full spec as Markdown.
- `getLabel(type: NodeType, index: number, partNumber?: number): string` — the CSI label for any node type (`A.` / `1.` / `a.` / `1)` / `a)`, repeated `1)` / `a)` for PR6/PR7, `PART N -`, `N.N`). Uses base-26 arithmetic for the `pr1` / `pr3` / `pr5` / `pr7` letter tiers so it handles >26 siblings correctly.
- `note` nodes always render as `> **[NOTE]** text` regardless of `meta.vanish` — editorial notes are structural metadata for spec writers, not owner-facing content.
- `meta.vanish` on non-note nodes → returns `''` (suppressed from output).

When the DOCX generator (Phase 2b) needs numbering labels, import `getLabel` from here rather than reimplementing.

## File Structure

```
specr/
├── src/                         # All TypeScript source
│   ├── index.ts                 # Entry: Express, env validation, graceful shutdown
│   ├── mcp/
│   │   ├── server.ts            # registerMcpRoutes(app) — Streamable HTTP routing: stateless + stateful sessions
│   │   ├── sessions.ts          # McpSessionStore — stateful session lifecycle (Map keyed by minted session id)
│   │   ├── tools.ts             # registerTools(server): search_library, list_sections, get_spec, get_paragraph, get_spec_lineage, get_spec_diff, get_numbering_profile, get_references, list_projects, parse_document, generate_docx, load_files, coordination_report, submittal_register, open_comments_report — and delegates to registerOnboardingTools (onboarding-tools.ts)
│   │   ├── onboarding-tools.ts  # registerOnboardingTools(server): review_editability, get_onboarding_report, set_/clear_editability_override, reclassify_spec (#140)
│   │   ├── onboarding-handlers.ts # handlers for the onboarding tools — thin adapters over the shared db/index.js queries (single source with REST)
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
│   └── lib/                     # Shared leaf utilities (errors, logger, env, encoding, jobs, section-number, …) — no barrel; imported per-file
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
├── eslint.config.js
├── .prettierrc
├── .env.example
├── docker-compose.yml           # PostgreSQL for local dev + integration tests
├── ARCHITECTURE.md              # This file
├── CLAUDE.md                    # Dev instructions for agents + contributors
├── LICENSE                      # TBD — open source
└── README.md
```

## Key Dependencies

Versions live in `package.json` / `pnpm-lock.yaml` — the lockfile is the authority. What each key dependency is for:

- `express` (v5) — HTTP server
- `zod` (v4) — all external-input validation (request bodies, env, parsed XML/OOXML); note v4 idioms like `z.uuid()`
- `docx` (dolanmiu) — DOCX generation
- `jszip` / `yauzl` — OOXML zip reading and archive safety checks
- `fast-xml-parser` — `.SEC` (SpecsIntact XML) and OOXML parsing
- `pg` + `node-pg-migrate` — PostgreSQL driver + reversible TypeScript migrations
- `pino` — structured logging
- `multer` — multipart upload handling
- `uuid` — content-control anchor and entity ids
- `piscina` — worker-thread pool for CPU-bound parsing
- `express-rate-limit` — rate limiting on public endpoints
- `@modelcontextprotocol/sdk` — MCP server (Streamable HTTP)
- `chardet` + `iconv-lite` — encoding detection / decoding
- Dev: `typescript`, `vitest` (+ `@vitest/coverage-v8`), `eslint` 9 flat config with `typescript-eslint` + `eslint-plugin-sonarjs` + `eslint-config-prettier`, `prettier`, `tsx` (dev server), `@redocly/cli` (OpenAPI lint), `depcheck`

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
