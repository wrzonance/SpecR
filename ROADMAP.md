# Roadmap

This roadmap reflects the state of `main` as of 2026-07-01.

## Current Status

SpecR has the backend foundation for parse (DOCX, `.SEC`, `.txt`, and PDF), persist, generate, diff, merge, template/style handling, editability and onboarding semantics, project coordination reporting, immutable package revisions with manual rendering, document-concurrency controls, and MCP read access.

The primary remaining product surfaces are the browser UI, authentication/multi-tenancy, full Revit/keynote sync, header/footer rendering, and later scale/DMS work.

## Included

### Parsing

- UFGS SpecsIntact `.SEC` parser with explicit Part/Article/paragraph hierarchy.
- DOCX parser using raw OOXML plus a 5-signal hierarchy inference engine: numbering XML, style chains, document order, text patterns, and indentation.
- DOCX source-fact capture for comments, run color, choice tokens, and persisted inference conflicts.
- Hidden/`vanish` OOXML content retained and excluded from structural inference, and suppressed correctly (not rendered as false notes) across all renderers.
- Hardened CSI PART inference for numbering-generated, manufacturer-authored DOCX.
- Plaintext `.txt` parser for read-only ingest.
- PDF ingest: text-layer extraction with a `pdfjs-dist` fallback, automatic OCR (`tesseract.js`) for scanned pages with bounded/offline-safe worker init, and font-encoding recovery, all feeding the shared text-inference path.
- Structural numbering profiles: extract from a DOCX, store per library, and apply as a deterministic override at parse time.
- Cross-reference extraction for CSI section refs and common standards bodies.
- Parse-warning surfacing for ambiguous or degraded inputs.

### Storage and Project Model

- Canonical CSI AST stored as recursive PostgreSQL paragraph rows (seven CSI tiers, including deep `pr6`/`pr7` nesting).
- Specs, versions, projects, project TOCs, references, libraries, project-owned copies, design packages, immutable package revisions, and lineage.
- Division general specs and project-scoped reference traversal.
- Project and library management APIs: list/create, rename, source-library ordering, client-tier library creation, and per-project section-number format.
- Spec and project soft-delete (withdraw) with restore and audit fields.
- Document lifecycle state, advisory locks, optimistic paragraph writes, and editability classification persistence.
- External-content associations linking paragraphs to external document references.

### Generation and Round Trip

- DOCX generator with CSI multilevel numbering and UUID content-control anchors.
- Style-template application during DOCX generation.
- Multi-section project manual assembly with numbering restarts.
- Cover page and Word TOC field generation.
- Revision/addendum manual rendering from immutable package-revision snapshots, consuming project revision-nomenclature profiles for cover and filename.
- Generation honors a project's saved section-number format.
- SpecsIntact `.SEC` output renderer.
- Markdown renderer shared by MCP resources.
- UUID-anchored diff and merge endpoints for returned reviewer DOCX files.

### Style, Conventions, and Editability

- JSONB style-template storage and CRUD.
- DOCX style-template import with consensus derivation reports.
- Manual style-source assignment for non-DOCX masters.
- Built-in and library-scoped editing convention profiles, including clone.
- Pure editability classification engine plus persisted classification and user override fields.
- Onboarding APIs: async library-master import, editability review/override, reclassify, finalize/reopen, comment-closure detection, and open-comments reporting. (The onboarding UI is still planned.)

### Coordination and Semantics

- Semantic article-role tagging (Related Sections, References, Submittals, and more) derived onto AST nodes.
- Authored required-sections substrate at project and package scope.
- Project coordination / errors-&-omissions report: required-vs-present, dangling references, Related-Sections/References article-body consistency, umbrella↔subordinate call-outs, and advisory implied related sections.
- Product-driven submittal register for selected project specs.

### MCP and Integrations

- Streamable HTTP MCP endpoint at `POST /mcp`.
- Read-oriented MCP tools/resources for library search, specs, paragraphs, sections, parse, generate, diff, and file loading.
- Optional stateful MCP sessions.
- Revit 2024 add-in scaffold with a health-check ribbon command and typed REST client.

## Active Planning Buckets

The open backlog is now organized around these working buckets:

| Bucket             | Focus                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| Maintenance        | Security and dependency cleanup that does not belong to a product phase.        |
| Phase 2c follow-up | Style substrate gaps (deep paragraph nesting shipped).                          |
| Phase 2e           | Header/footer composition (revision nomenclature + addenda rendering shipped).  |
| Phase 4            | Revit/keynote integration and model-to-spec coordination.                       |
| Phase 5            | Browser UI, auth, multi-tenant isolation, MCP write tools, and UI workflows.    |
| Onboarding         | Onboarding UI, conformance, and restyle (import + editability review shipped).  |
| Phase 6            | Scale and performance work such as DOCX caching.                                |

## Planned Work

### Near Term

- Complete header/footer composition: the DB config and AST schema foundations exist (variants, page-number policy, raw sidecar), but resolution, generator rendering, and parser capture are still to build.
- Surface keynotes beyond storage: the keynote master table and project-filtered query exist; export and Revit-facing surfaces are still planned.
- Ongoing dependency/security maintenance.

### Product Buildout

- Build Phase 4 Revit/keynote surfaces: model mappings, keynote export, link inventory, preflight checks, add-in sync, and change detection.
- Build Phase 5 browser UI: frontend scaffold, parse/spec viewer, merge review, template management, library management, auth, MCP write tools, and Revit link browser.
- Build the onboarding UI on top of the shipped onboarding APIs (import, editability review, classification correction, convention tuning).

### Later

- Conformance audit and restyle workflows for mixed master sources.
- DOCX cache layer and scale/performance work.
- DMS/content connector framework and BYO-license content ingestion adapters.

## Non-Goals For Now

- Bundling copyrighted master specification content.
- Treating DOCX as the source of truth.
- Adding a browser UI before the API contracts it consumes are stable.
- Enforcing coverage percentages instead of useful boundary tests.
