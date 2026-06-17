# SpecR

Headless REST API for CSI MasterFormat-compatible specification automation.
SpecR parses specification documents into a canonical CSI AST, stores the result
in PostgreSQL, and renders the same structure back to DOCX, Markdown, JSON, and
SpecsIntact `.SEC`.

SpecR is an independent project and is not affiliated with CSI.

## What It Does

SpecR treats specifications as structured data rather than opaque Word files.
The core workflow is:

1. Upload a `.docx`, `.SEC`, or `.txt` spec.
2. Parse it into a parent/child CSI paragraph tree.
3. Store the canonical AST and paragraph lineage in PostgreSQL.
4. Generate DOCX or `.SEC` output from the AST.
5. Diff and merge reviewer-edited DOCX files back into the database by UUID
   content-control anchors.

The current backend is API-first. Browser UI, authentication, and full Revit
sync workflows are still roadmap items.

## Included Today

- DOCX parser with 5-signal hierarchy inference, inference-conflict surfacing,
  source-fact capture, and ARCAT/CPI/LibreOffice fixture coverage.
- UFGS SpecsIntact `.SEC` parser and `.SEC` output renderer.
- Plaintext `.txt` parser for read-only ingest.
- PostgreSQL-backed specs, paragraphs, versions, projects, libraries, design
  packages, package revisions, style templates, conventions, locks, and lineage.
- DOCX generator with CSI multilevel numbering, content-control UUID anchors,
  style-template application, multi-section manual assembly, cover page, and TOC
  field support.
- Diff and merge endpoints for round-trip reviewer redlines.
- Style-template CRUD, DOCX template import, convention profile CRUD, and
  editability classification persistence with user overrides.
- MCP Streamable HTTP server with read-oriented tools/resources and optional
  stateful sessions.
- Revit 2024 add-in scaffold with a typed REST client and health-check ribbon
  command.

See [ROADMAP.md](ROADMAP.md) for the fuller capability inventory and planned
work.

## API Surface

The canonical contract is [openapi.yaml](openapi.yaml). Key groups:

- Parsing: `POST /parse`, `GET /parse/jobs/{jobId}`
- Specs: `GET/PATCH /specs/{id}`, paragraph updates, lineage, locks
- Generation: `POST /specs/{id}/generate`, `POST /projects/{id}/generate`
- Round trip: `POST /specs/{id}/diff`, `POST /specs/{id}/merge`
- Projects and references: project TOCs, broken refs, inbound refs
- Packages and revisions: design packages and immutable revision snapshots
- Templates and conventions: style templates, DOCX template import, convention
  profiles
- MCP: `POST /mcp`

## Quick Start

```bash
pnpm install
docker compose up -d postgres
pnpm migrate
pnpm seed
pnpm dev
```

The API starts on the port configured by `.env` (see [.env.example](.env.example)).

Useful commands:

```bash
pnpm test
pnpm test:integration
pnpm lint
pnpm build
pnpm load:files 'docs/references/UFGS/**/*.SEC'
```

Development workflow, testing rules, and local Postgres notes live in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

The full design is in [ARCHITECTURE.md](ARCHITECTURE.md). The short version:

- `src/ast/` owns the canonical CSI AST and schemas.
- `src/parser/` converts DOCX, `.SEC`, and `.txt` into the AST.
- `src/generator/` renders AST output to DOCX, Markdown, and `.SEC`.
- `src/merge/` performs UUID-anchored 3-way diff and merge.
- `src/db/` owns migrations and persistence queries.
- `src/api/` exposes REST routes.
- `src/mcp/` exposes MCP tools and resources.
- `revit-addin/` contains the separate C#/.NET Revit add-in scaffold.

Module boundaries are intentionally strict: import sibling modules through their
`index.ts` barrels, not internal files.

## Reference Data

- `docs/references/UFGS/` contains public-domain UFGS `.SEC` seed data.
- `docs/references/ARCAT/README.md` and
  `docs/references/MANUFACTURER_CPI/README.md` describe fixture acquisition for
  copyrighted vendor samples that are not stored in this repository.

## License

See [LICENSE](LICENSE) and [NOTICES](NOTICES).
