# Roadmap

This roadmap reflects the state of `main` as of 2026-06-17.

## Current Status

SpecR has the backend foundation for parse, persist, generate, diff, merge,
template/style handling, editability semantics, MCP read access, and project
manual assembly. The primary remaining product surfaces are the browser UI,
authentication/multi-tenancy, full Revit sync, PDF ingest, and later scale/DMS
work.

## Included

### Parsing

- UFGS SpecsIntact `.SEC` parser with explicit Part/Article/paragraph hierarchy.
- DOCX parser using raw OOXML plus a 5-signal hierarchy inference engine:
  numbering XML, style chains, document order, text patterns, and indentation.
- DOCX source-fact capture for comments, run color, choice tokens, and persisted
  inference conflicts.
- Plaintext `.txt` parser for read-only ingest.
- Cross-reference extraction for CSI section refs and common standards bodies.
- Parse-warning surfacing for ambiguous or degraded inputs.

### Storage and Project Model

- Canonical CSI AST stored as recursive PostgreSQL paragraph rows.
- Specs, versions, projects, project TOCs, references, libraries, project-owned
  copies, design packages, immutable package revisions, and lineage.
- Division general specs and project-scoped reference traversal.
- Document lifecycle state, advisory locks, optimistic paragraph writes, and
  editability classification persistence.

### Generation and Round Trip

- DOCX generator with CSI multilevel numbering and UUID content-control anchors.
- Style-template application during DOCX generation.
- Multi-section project manual assembly with numbering restarts.
- Cover page and Word TOC field generation.
- SpecsIntact `.SEC` output renderer.
- Markdown renderer shared by MCP resources.
- UUID-anchored diff and merge endpoints for returned reviewer DOCX files.

### Style, Conventions, and Editability

- JSONB style-template storage and CRUD.
- DOCX style-template import with consensus derivation reports.
- Manual style-source assignment for non-DOCX masters.
- Built-in and library-scoped editing convention profiles.
- Pure editability classification engine plus persisted classification and user
  override fields.

### MCP and Integrations

- Streamable HTTP MCP endpoint at `POST /mcp`.
- Read-oriented MCP tools/resources for library search, specs, paragraphs,
  sections, parse, generate, diff, and file loading.
- Optional stateful MCP sessions.
- Revit 2024 add-in scaffold with a health-check ribbon command and typed REST
  client.

## Active Planning Buckets

The open backlog is now organized around these working buckets:

| Bucket             | Focus                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| Maintenance        | Security and dependency cleanup that does not belong to a product phase.        |
| Phase 2c follow-up | Deep paragraph nesting and style substrate gaps.                                |
| Phase 2e           | Project-manual issuance, addenda, revision nomenclature, and headers/footers.   |
| Phase 3+           | PDF ingest and other high-friction document sources.                            |
| Phase 4            | Revit/keynote integration and model-to-spec coordination.                       |
| Phase 5            | Browser UI, auth, multi-tenant isolation, MCP write tools, and UI workflows.    |
| Onboarding         | Master import, editability review, convention tuning, conformance, and restyle. |
| Phase 6            | Scale and performance work such as DOCX caching.                                |

## Planned Work

### Near Term

- Complete dependency/security cleanup for the remaining Vite alert.
- Finish Phase 2e foundations: revision nomenclature and header/footer
  composition.
- Rework manual issuance/addenda rendering to consume structured revision
  metadata.

### Product Buildout

- Build Phase 4 Revit/keynote surfaces: model mappings, keynote export, link
  inventory, preflight checks, coordination report, add-in sync, and change
  detection.
- Build Phase 5 browser UI: frontend scaffold, parse/spec viewer, merge review,
  template management, library management, auth, MCP write tools, and Revit link
  browser.
- Build onboarding APIs and UI for importing masters, reviewing editability,
  correcting classifications, and tuning convention profiles.

### Later

- PDF ingest with extraction fallback, OCR detection, reading-order repair, and
  hierarchy inference.
- Conformance audit and restyle workflows for mixed master sources.
- DOCX cache layer and scale/performance work.
- DMS/content connector framework and BYO-license content ingestion adapters.

## Non-Goals For Now

- Bundling copyrighted master specification content.
- Treating DOCX as the source of truth.
- Adding a browser UI before the API contracts it consumes are stable.
- Enforcing coverage percentages instead of useful boundary tests.
