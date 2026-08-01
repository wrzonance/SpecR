# Contributing

This project is TypeScript/Node 24 LTS (pinned via `.nvmrc` — see [Node version](#node-version) and ADR-081), Express, Zod, PostgreSQL, Vitest, and pnpm. The repository is ESM (`"type": "module"`), so relative TypeScript imports use `.js` extensions.

## Node version

The repo is pinned to **Node 24 LTS** (ADR-081). `.nvmrc` is the single source of truth — CI reads
the same file via `actions/setup-node`'s `node-version-file`, so local and CI run the identical
major. Switch before installing:

| Manager | Command |
| --- | --- |
| nvm | `nvm use` (`nvm install` first if you don't have 24) |
| fnm | `fnm use` — add `eval "$(fnm env --use-on-cd)"` to your shell rc to switch automatically on `cd` |
| asdf | `asdf install nodejs` (needs the `asdf-nodejs` plugin) |
| mise | `mise settings add idiomatic_version_file_enable_tools node` once, then `mise install` |

Volta is the exception: it ignores `.nvmrc` entirely and reads only a `volta` key in
`package.json`. We deliberately don't add one — it would be a second source of truth that can
silently win over `engines.node`. If you use Volta, switch to 24 manually.

This is convention, not the enforcement. `pnpm install` **fails** on the wrong major
(`engineStrict` in `pnpm-workspace.yaml`), so a missed switch is loud rather than silent:

```
Expected version: >=24 <25
Got: v26.4.0
```

`pnpm check:node-pin` asserts `.nvmrc`, both `engines.node` ranges, both `@types/node` majors and
the running interpreter all agree; it runs in CI and locally.

## Setup

```bash
nvm use                 # or fnm/asdf/mise — see Node version above
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

## Changing the parser? A/B the corpus first

The inference/parsing engine is the product. Any change to a parsing **regex** or
inference **signal** can silently reshape how hundreds of fixtures parse. Before and
after every such change, snapshot the whole reference corpus and diff:

```bash
pnpm fixture:snapshot before   # known-good baseline
# …make the parser change…
pnpm fixture:snapshot after
pnpm fixture:diff before after
```

Verify that **only the fixtures you intended to change** moved, that every real spec
still resolves to 3 parts, and that no specifier-note banner leaked into body text
(`noteLeaks` must not rise). The reference corpus is copyrighted and gitignored, so the
tool runs locally — snapshots are written to `.fixture-snapshots/` (also gitignored).
The always-on guard for the 3-part invariant is `corpus-parts.integration.test.ts`;
run it with `pnpm test:integration` where the corpus is present. A committed
banner-leak assertion is being folded into that same test as a follow-up.

## Documentation

Use ADRs for non-obvious decisions, rejected common approaches, or choices that will surprise a future reader. Add new ADRs under `docs/adr/NNN-title.md` with Status, Context, Decision, and Consequences.

For larger design work, keep design notes in `docs/superpowers/specs/` and plans in `docs/superpowers/plans/`, following the existing files.

## Revit Add-In

The Revit add-in is a separate C#/.NET solution in [revit-addin/](revit-addin/). Build it with `dotnet build` from that directory. The pnpm commands above do not apply to the add-in.
