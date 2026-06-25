# SpecR

Follows the global `~/.claude/rules` (code · workflow · security · agents). This file holds only SpecR-specific facts and overrides. Full design: `ARCHITECTURE.md`.

Headless REST API for CSI MasterFormat specification automation: round-trip DOCX (and UFGS `.SEC`) ↔ canonical CSI AST in PostgreSQL, with a git-style 3-way merge engine for owner/editor redlines. TypeScript/Node 22, Express, Zod, pnpm.

## Project overrides

These tighten or replace the global defaults — they win where they differ.

- **GitHub PRs created by Claude or Codex must be drafts.** Use `gh pr create --draft` or connector `draft: true`; do not create a ready-for-review PR directly.
- **ESLint complexity is enforced, not advisory** (`eslint.config.js`): `complexity` = 10, `sonarjs/cognitive-complexity` = 10, `max-lines-per-function` = 50, `max-lines` = 400 (file cap is **400**, not the global 800), `no-console` = error, `@typescript-eslint/no-explicit-any` = error. Test files (`src/**/*.test.ts`) and `scripts/**/*.ts` relax line/console caps — see the config for the exact exemptions.
- **TypeScript strict, plus** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. No `any`, no `as unknown as`, no type assertions across module boundaries, no non-null assertion (`!`) outside tests.
- **Coverage is a DIAGNOSTIC, not a target.** No enforced percentage. Tests at module API boundaries beat tests on internals. Every bug-fix is pinned with a regression test whose name states the symptom, e.g. `'inference: CPI ilvl gap — Article at ilvl=3, not ilvl=1'`.
- **OOXML ambiguity rule:** the inference engine has genuinely ambiguous cases. Document each one IN A TEST marked `// KNOWN AMBIGUITY: <description>` — never silently pick a behavior.
- **ADRs required for non-obvious decisions.** When choosing between viable approaches, rejecting a popular one, or making a choice that will surprise a future reader, add `docs/adr/NNN-title.md` (Status / Context / Decision / Consequences). The existing series (001–022) is the running record.
- **CI `loc-check` warns** when a PR's LOC delta > 500 (excludes fixtures, migrations, `pnpm-lock.yaml`, `openapi.yaml`, `docs/references/`). Warn-only; the reviewer enforces.
- **Commit scope = the module changed**, e.g. `feat(parser): add numbering.xml analyzer`.

## Module-boundary error classes

Every module owns a typed error class extending `SpecrError` (`src/lib/errors.ts`): `ParserError`, `GeneratorError`, `MergeError`. Chain `cause` at every catch site where the caller adds meaning, so the error reads as a why-chain from origin to surface. Validate all external input (request bodies, env, parsed XML/OOXML) with Zod and chain the `ZodError` as the cause.

```typescript
// parser/docx/numbering.ts
try {
  return parseNumberingXml(xml)
} catch (err) {
  throw new ParserError('failed to build numbering map from numbering.xml', { cause: err })
}
```

Anti-patterns rejected in review: swallowing context (`catch { throw new ParserError('failed') }`), `any` across a boundary, `!` in non-test code, untyped raw `Error` at a module surface. The API error middleware (`src/api/middleware/error.ts`) maps boundary errors to `ApiResponse<never>`: `ParserError` → 422, `MergeError` (conflict) → 409, unknown → 500. Stack traces never leave the process.

## Architecture (summary — full detail in `ARCHITECTURE.md`)

- **Canonical CSI AST** (`src/ast/`) is the source of truth — not OOXML, not the DB rows. Renders to DOCX, Markdown, JSON.
- **Parser** (`src/parser/`): `.SEC` (SpecsIntact XML, fast-xml-parser) and DOCX (raw OOXML via JSZip) → AST. DOCX hierarchy is inferred by a **5-signal engine** (numbering.xml, style chains, document order, text regex, indentation), ported/extended from Clippit's `ListItemRetriever`. See `ARCHITECTURE.md` → "5-Signal Inference Engine".
- **Generator** (`src/generator/`): AST → DOCX (dolanmiu/docx, full CSI multilevel numbering) with `w:sdt` UUID content controls as round-trip merge anchors. `markdown.ts` is a pure shared renderer (`renderMarkdown`, `getLabel`).
- **Merge** (`src/merge/`): UUID-anchored, git-style 3-way diff (base/ours/theirs) + conflict detection.
- **MCP** (`src/mcp/`): stateless Streamable HTTP at `POST /mcp` — one `McpServer` per request. Read-only tools/resources today.
- **Module boundaries are hard:** modules import only from a sibling's `index.ts` barrel, never its internals (`import { parse } from '../parser/index.js'`, never `'../parser/docx/numbering.js'`). Per-module dependency rules live in `ARCHITECTURE.md` → "Module Boundaries". For MCP tool/resource patterns and the markdown renderer contract, see `ARCHITECTURE.md` → "MCP Server" and "Markdown Renderer".

## Build / test / lint

```bash
pnpm install
pnpm dev                # tsx watch — hot-reload dev server
pnpm build              # tsc → dist/
pnpm start              # node dist/index.js
pnpm lint               # eslint src/ && tsc --noEmit && prettier --check src/
pnpm format             # prettier --write src/
pnpm test               # unit tests (vitest --project unit) — no DB
pnpm test:integration   # integration tests (vitest --project integration) — needs PostgreSQL
pnpm test:coverage      # coverage report (diagnostic only)
pnpm migrate            # node-pg-migrate up
pnpm migrate:down       # roll back last migration
pnpm seed               # seed CSI section reference data (spec_sections)
```

### PostgreSQL for integration tests

Integration tests and DB-query tests run against a real Postgres — never mocked.

```bash
docker compose up -d postgres        # postgres:16, db/user/pass all "specr", :5432
# native: Arch `sudo pacman -S postgresql` · Ubuntu `sudo apt install postgresql libpq-dev`
```

CI sequence (the order matters): `pnpm migrate → pnpm seed → pnpm test → pnpm test:integration`. **`pnpm seed` is required before integration tests** — `listSpecSections` and the MCP `list_sections` tool depend on seeded `spec_sections` data. `DATABASE_URL` comes from `.env` (see `.env.example`). The `dev`, `start`, `migrate`/`migrate:down`, `seed`, and `load:files` scripts **auto-load `.env`** (Node's `--env-file-if-exists` for the `node`/`tsx` ones; node-pg-migrate's `--envPath` for migrate) — so no inline env is needed locally. Real shell/CI env vars take precedence over the file, and a missing `.env` still fails fast at the Zod check. Test runners are intentionally excluded.

## Conventions

- No `console.*` in `src/` (outside test/scripts) — use the pino logger at `src/lib/logger.ts`.
- DB migrations are always reversible (paired up + down); migration files are the schema of record, not test targets.
- `src/lib/env.ts` validates env with Zod and exits the process on invalid config — fail fast at boot.
- **`openapi.yaml` is the live, authoritative API contract — adhere to it.** It is hand-authored truth (ADR-026), now rendered as-is at `/docs` (Scalar) and served at `GET /openapi.yaml`, **and CI-enforced** by the contract gate (`src/api/contract.integration.test.ts`): bidirectional route↔spec coverage + response-schema validation. Any endpoint change (path, method, request/response shape, or status) **must update `openapi.yaml` in the same PR** — otherwise `/docs` renders something the code doesn't do and CI goes red three ways (undocumented route, documented-but-unrouted op, or a response that no longer matches its schema). Code conforms to the spec, not the reverse.
- The 666-file UFGS `.SEC` corpus is seed/proof-of-concept data, not the product. The product is the inference engine and round-trip fidelity — don't let library content drive scope.

## Gotchas

- **CPI ilvl offset:** CPI-authored DOCX reserves ilvl 1–2 for Schedule/PDS, so the same logical CSI Article maps to a different `ilvl` than ARCAT files. The inference engine normalizes this — test new inference changes against both ARCAT (cleanest) and CPI fixtures.
- **Inference conflicts are persisted, not discarded:** when signals disagree, losing signals are written to `paragraphs.conflicts` (JSONB, `NOT NULL DEFAULT '[]'`) and surface as `meta.conflicts`. Don't "resolve" by dropping them.
- **MCP tools never throw:** return `{ isError: true, content: [...] }` on failure. Import DB functions from `../db/index.js` only. Use `z.uuid()` (Zod v4), not `z.string().uuid()`.
- **Markdown `note` nodes always render** as `> **[NOTE]** …` regardless of `meta.vanish`; `meta.vanish` on non-note nodes suppresses output (`''`).
- Don't reimplement CSI numbering labels — import `getLabel` from `src/generator/markdown.ts`.
- ESM project (`"type": "module"`): relative imports use `.js` extensions; `verbatimModuleSyntax` requires `import type` for type-only imports.
