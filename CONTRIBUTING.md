# Contributing

This project is TypeScript/Node 22, Express, Zod, PostgreSQL, Vitest, and pnpm. The repository is ESM (`"type": "module"`), so relative TypeScript imports use `.js` extensions.

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm migrate
pnpm seed
```

`pnpm seed` is required before integration tests. It loads the `spec_sections` reference data used by `listSpecSections` and the MCP `list_sections` tool.

## Common Commands

```bash
pnpm dev                # tsx watch server
pnpm build              # tsc
pnpm start              # node dist/index.js
pnpm lint               # eslint src/ && tsc --noEmit && prettier --check src/
pnpm format             # prettier --write src/
pnpm test               # unit tests, no DB
pnpm test:integration   # integration tests, needs PostgreSQL
pnpm test:coverage      # diagnostic coverage report
pnpm migrate            # run migrations
pnpm migrate:down       # roll back last migration
pnpm seed               # seed spec_sections
pnpm seed:corpus        # load UFGS corpus
```

CI order matters:

```bash
pnpm migrate
pnpm seed
pnpm test
pnpm test:integration
```

## Quality Rules

- TypeScript is strict and uses `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, and `verbatimModuleSyntax`.
- ESLint enforces `complexity`, cognitive complexity, function length, file length, no `console.*` in `src/`, and no `any`.
- Use `import type` for type-only imports.
- Do not use non-null assertions outside tests.
- Validate external input with Zod.
- Use typed module-boundary errors from `src/lib/errors.ts`; chain `cause` when adding context.
- Keep `openapi.yaml` in sync with REST endpoint changes.
- DB migrations are reversible and are the schema of record.

## Testing

Unit tests should exercise module APIs. Integration and DB-query tests run against real PostgreSQL; do not mock Postgres for those paths.

Bug fixes need a regression test whose name states the symptom. DOCX inference ambiguity is expected in some cases, but it must be documented in a test with:

```typescript
// KNOWN AMBIGUITY: <description>
```

Coverage is diagnostic only. Prefer meaningful boundary coverage over percentage chasing.

## Documentation

Use ADRs for non-obvious decisions, rejected common approaches, or choices that will surprise a future reader. Add new ADRs under `docs/adr/NNN-title.md` with Status, Context, Decision, and Consequences.

For larger design work, keep design notes in `docs/superpowers/specs/` and plans in `docs/superpowers/plans/`, following the existing files.

## Revit Add-In

The Revit add-in is a separate C#/.NET solution in [revit-addin/](revit-addin/). Build it with `dotnet build` from that directory. The pnpm commands above do not apply to the add-in.
