# File Structure

> ↩ [Architecture index](../../ARCHITECTURE.md)

```text
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
│   └── fixtures/                # .SEC / .docx / text fixtures (unit + integration tests live in src/ as *.test.ts / *.integration.test.ts)
├── docs/
│   ├── adr/                     # Architecture Decision Records
│   ├── architecture/            # Architecture deep-dives (split from ARCHITECTURE.md)
│   └── references/              # UFGS .SEC corpus + README for copyrighted sources
├── .github/
│   ├── workflows/
│   │   ├── ci.yml               # Lint, test, build, LOC check on PR
│   │   ├── release.yml          # Audit, version check, AI notes, release on tag
│   │   ├── codeql.yml           # Weekly security scan
│   │   └── claude.yml           # Claude PR-review workflow
│   └── PULL_REQUEST_TEMPLATE.md
├── openapi.yaml                 # OpenAPI 3.1 spec — authoritative API contract
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── eslint.config.js
├── .prettierrc
├── .env.example
├── docker-compose.yml           # PostgreSQL for local dev + integration tests
├── ARCHITECTURE.md              # Architecture index → docs/architecture/*
├── CLAUDE.md                    # Dev instructions for agents + contributors
├── LICENSE                      # MIT
└── README.md
```
