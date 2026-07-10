# SpecR

Follows the global `~/.claude/rules` (code · workflow · security · agents). This file holds only SpecR-specific facts and overrides. Full design: `ARCHITECTURE.md`.

Headless REST API for CSI MasterFormat specification automation: round-trip DOCX (and UFGS `.SEC`) ↔ canonical CSI AST in PostgreSQL, with a git-style 3-way merge engine for owner/editor redlines. TypeScript/Node 22, Express, Zod, pnpm.

## Talking to users

Two audiences use this repo: **developers** debugging source, and **AEC specifiers / spec editors** who iterate on how their documents parse and may not read TypeScript or OOXML. Read which one is asking and match register.

**Scope:** this governs how you *present* a finished answer — not how you reason, read code, or diagnose. Reason at full technical precision and keep exact identifiers (`ilvl`, `w:sdt`, `numId`) verbatim in analysis, code, comments, and commits. Translate to plain terms only at the presentation layer, never in the thinking that gets you there.

- **Default to domain-first.** Lead with a plain answer in spec-editor terms — PART / Article / Paragraph, the section number ("09 91 26"), the three-part format (General · Products · Execution), the outline, the redline. Put OOXML/algorithm detail underneath, clearly marked. Don't open with a tag name or a raw `ilvl`.
- **Progressive disclosure, not dumbing down.** Reason technically *first*, then render plain; keep the depth one offer away ("want the OOXML detail?"), never front-loaded. Developer questions (stack trace, type error, engine internals) get full technical register.
- **On a mis-parse, give an action they can take in Word.** The five signals map to fixable things: list numbering (S1), Word style (S2), position vs. neighbours (S3), the typed prefix "A."/"PART 2" (S4), left indent (S5). If the source genuinely can't be made decidable, say so and call it a **KNOWN AMBIGUITY** — don't invent a fix.
- When unsure who's asking, ask once: *"Spec-level or code-level explanation?"*

**Plain-language glossary** — say the left; add the code term in parens or on request (grounded in `src/ast/types.ts`, `src/ast/labels.ts`, `docs/architecture/inference-engine.md`):

| Say this | Internal term |
|---|---|
| the whole section | `spec` / `SpecTree` |
| PART 1/2/3 (General · Products · Execution) | `part` (ilvl 0) |
| an Article ("1.2 REFERENCES") | `article` (ilvl 1) |
| the sub-tiers under an Article: A. → 1. → a. → 1) → a) | `pr1`–`pr7` (ilvl 2–8) |
| the outline level (0 = PART, then Article, then each tier) | `ilvl` |
| an editorial note (always shown as **[NOTE]**, for spec writers) | `note` |
| hidden content, suppressed from output | `meta.vanish` (non-note) |
| the five clues SpecR weighs to place each paragraph | 5-signal engine |
| how the paragraph's list is numbered in Word | S1 `numbering.xml` |
| the paragraph's Word style (PR1, Heading 4, Normal…) | S2 style chain |
| where it sits vs. the paragraphs around it | S3 document order |
| the literal typed prefix ("A.", "PART 2") | S4 text pattern |
| how far it's indented on the page | S5 indentation |
| how sure SpecR is (0–1) and the plain why | `confidence` / `evidence` |
| the clues disagreed — losing guesses are kept, never hidden | `conflicts` |
| which tool authored the master (a label — never drives logic) | `meta.source` |
| the pick-one / fill-in placeholders (`<insert>`, `[optional]`) | `choiceTokens` |
| may an editor change this paragraph: locked · editable · choice · note | `editability` |

## Project overrides

These tighten or replace the global defaults — they win where they differ.

- **Claude/Codex PRs are drafts** — `gh pr create --draft` (or connector `draft: true`); never open ready-for-review directly.
- **ESLint is enforced, not advisory** (`eslint.config.js`): `complexity` 10, `sonarjs/cognitive-complexity` 10, `max-lines-per-function` 50, `max-lines` **400** (not the global 800), `no-console` and `@typescript-eslint/no-explicit-any` = error. Tests (`src/**/*.test.ts`) relax line/function/console caps; `scripts/**/*.ts` relax `no-console` only.
- **TypeScript strict, plus** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. No `any`, no `as unknown as`, no cross-boundary type assertions, no non-null `!` outside tests.
- **Coverage is a DIAGNOSTIC, not a target** — no enforced %. Test at module API boundaries, not internals. Pin every bug-fix with a regression test named for the symptom, e.g. `'inference: CPI ilvl gap — Article at ilvl=3, not ilvl=1'`.
- **OOXML ambiguity rule:** document each genuinely ambiguous inference case IN A TEST marked `// KNOWN AMBIGUITY: <description>` — never silently pick a behavior.
- **ADRs for non-obvious decisions** — choosing between viable approaches, rejecting a popular one, or anything that will surprise a future reader → add `docs/adr/NNN-title.md` (Status / Context / Decision / Consequences); see the running series.
- **CI `loc-check` warns** on a PR LOC delta > 500 (excludes fixtures, migrations, `pnpm-lock.yaml`, `openapi.yaml`, `docs/references/`). Warn-only; the reviewer enforces.
- **Commit scope = the module changed**, e.g. `feat(parser): add numbering.xml analyzer`.

## Module-boundary error classes

Every module owns a typed error extending `SpecrError` (`src/lib/errors.ts`): `ParserError`, `GeneratorError`, `MergeError`. Chain `cause` at each catch site that adds meaning, so the error reads as a why-chain from origin to surface. Validate all external input (request bodies, env, parsed XML/OOXML) with Zod and chain the `ZodError` as the cause.

```typescript
// parser/docx/numbering.ts
try {
  return parseNumberingXml(xml)
} catch (err) {
  throw new ParserError('failed to build numbering map from numbering.xml', { cause: err })
}
```

Anti-patterns rejected in review: swallowing context (`catch { throw new ParserError('failed') }`), `any` across a boundary, `!` in non-test code, untyped raw `Error` at a module surface. The shared error middleware (`src/api/middleware/error.ts`) maps `MulterError` → 400 and otherwise responds `err.status ?? 500` as `ApiResponse<never>`; specific statuses are set upstream — Zod validation → 422 (`src/api/middleware/validate.ts`), version/lock/edit-gate conflicts → 409 (`src/api/edit-gate-response.ts`, `src/api/locks.ts`). Stack traces never leave the process.

## Architecture (summary — full detail in `ARCHITECTURE.md`)

- **Canonical CSI AST** (`src/ast/`) is the source of truth — not OOXML, not the DB rows. Renders to DOCX, Markdown, JSON.
- **Parser** (`src/parser/`): `.SEC` (SpecsIntact XML, fast-xml-parser) and DOCX (raw OOXML via JSZip) → AST. DOCX hierarchy is inferred by a **5-signal engine** (numbering.xml, style chains, document order, text regex, indentation), ported/extended from Clippit's `ListItemRetriever`. See `docs/architecture/inference-engine.md`.
- **Generator** (`src/generator/`): AST → DOCX (dolanmiu/docx, full CSI multilevel numbering) with `w:sdt` UUID content controls as round-trip merge anchors. `markdown.ts` is a pure shared renderer (`renderMarkdown`, `getLabel`).
- **Merge** (`src/merge/`): UUID-anchored, git-style 3-way diff (base/ours/theirs) + conflict detection.
- **MCP** (`src/mcp/`): stateless Streamable HTTP at `POST /mcp` — one `McpServer` per request. Tools are contract-bound to the REST surface (`contract-map.ts`, ADR-044) and tier-gated read/write/destructive (`capabilities.ts`, ADR-045); destructive tools are off by default.
- **Module boundaries are hard:** modules import only from a sibling's `index.ts` barrel, never its internals (`import { parse } from '../parser/index.js'`, never `'../parser/docx/numbering.js'`). Per-module dependency rules live in `docs/architecture/module-boundaries.md`. For MCP tool/resource patterns and the markdown renderer contract, see `docs/architecture/mcp.md` and `docs/architecture/markdown-renderer.md`.

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

CI order matters: `pnpm migrate → seed → test → test:integration`. **`seed` is required before integration tests** — `listSpecSections` and the MCP `list_sections` tool need seeded `spec_sections` data. `DATABASE_URL` comes from `.env` (`.env.example`); the `dev`, `start`, `migrate`/`migrate:down`, `seed`, and `load:files` scripts auto-load it (Node `--env-file-if-exists`; migrate via `--envPath`). Real env vars override the file; a missing `.env` still fails fast at the Zod check. Test runners are intentionally excluded.

## Conventions

- No `console.*` in `src/` (outside test/scripts) — use the pino logger at `src/lib/logger.ts`.
- DB migrations are always reversible (paired up + down); migration files are the schema of record, not test targets.
- `src/lib/env.ts` validates env with Zod and exits the process on invalid config — fail fast at boot.
- **`openapi.yaml` is the live, authoritative API contract — adhere to it.** Hand-authored truth (ADR-026), rendered at `/docs` (Scalar) and served at `GET /openapi.yaml`, CI-enforced by the contract gate (`src/api/contract.integration.test.ts`): bidirectional route↔spec coverage + response-schema validation. Any endpoint change (path, method, request/response shape, status) **must update `openapi.yaml` in the same PR**, or CI goes red three ways (undocumented route, documented-but-unrouted op, or a response mismatching its schema). Code conforms to the spec, not the reverse.
- **The MCP tool surface is contract-bound to the API (ADR-044).** Every user-facing OpenAPI operation maps to an MCP tool or an explicit `MCP_UNEXPOSED` entry (`src/mcp/contract-map.ts`), CI-enforced (`src/mcp/contract.integration.test.ts`, INV-1/2/3). Each tool declares a `read`/`write`/`destructive` tier (`src/mcp/capabilities.ts`); `MCP_ALLOWED_TIERS` (default `read,write`) gates exposure — destructive/admin actions off by default (ADR-045).
- The 666-file UFGS `.SEC` corpus is seed/proof-of-concept data, not the product. The product is the inference engine and round-trip fidelity — don't let library content drive scope.

## Gotchas

- **CPI ilvl offset:** CPI-authored DOCX reserves ilvl 1–2 for Schedule/PDS, so the same logical CSI Article maps to a different `ilvl` than ARCAT files. The inference engine normalizes this — test new inference changes against both ARCAT (cleanest) and CPI fixtures.
- **Inference conflicts are persisted, not discarded:** when signals disagree, losing signals are written to `paragraphs.conflicts` (JSONB, `NOT NULL DEFAULT '[]'`) and surface as `meta.conflicts`. Don't "resolve" by dropping them.
- **MCP tools never throw:** return `{ isError: true, content: [...] }` on failure. Import DB functions from `../db/index.js` only. Use `z.uuid()` (Zod v4), not `z.string().uuid()`.
- **Markdown `note` nodes always render** as `> **[NOTE]** …` regardless of `meta.vanish`; `meta.vanish` on non-note nodes suppresses output (`''`).
- Don't reimplement CSI numbering labels — import `getLabel` from `src/generator/markdown.ts`.
- ESM project (`"type": "module"`): relative imports use `.js` extensions; `verbatimModuleSyntax` requires `import type` for type-only imports.
