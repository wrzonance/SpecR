# Header/Footer Variants + Page-Number Policy + Raw Sidecar (AST) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the canonical `HeaderFooterCompositionSchema` (AST layer) with Word-style page variants (default/first/even), a page-numbering policy, and an open `raw` sidecar — while keeping every existing #208/v1 `{ header, footer, style }` payload valid as the default variant.

**Architecture:** Additive Zod-schema extension only. The v1 fields (`header`/`footer`/`style`) stay at the top level and remain the implicit `default` variant; v2 adds an optional `variants` object, `pageNumbering`, and `raw`. A small pure accessor `defaultVariant(config)` makes the v1→default backward-compat contract executable. Resolution across scopes (#304), rendering (#303), and parser capture (#306) are out of scope.

**Tech Stack:** TypeScript (strict + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`), Zod v4 (`z.json()`, `.exactOptional()`, `.catchall()`), Vitest (unit project, no DB).

## Global Constraints

- File cap 400 LOC; function cap 50 LOC; complexity ≤10; no `any`; no `!` outside tests; no `console.*` in `src/`. (`eslint.config.js`)
- ESM: relative imports use `.js`; type-only imports use `import type`.
- Change confined to: `src/ast/header-footer-schemas.ts`, new `src/ast/header-footer-schemas.test.ts`, barrel `src/ast/index.ts`, and new `docs/adr/040-header-footer-fidelity.md`.
- Additive only — existing v1 payloads and open `.catchall` extension keys MUST keep validating and round-tripping.
- `default` variant precedence: explicit `variants.default` wins over top-level v1 fields (documented `// KNOWN AMBIGUITY`).

---

### Task 1: Extend the schema + add the `defaultVariant` accessor

**Files:**
- Modify: `src/ast/header-footer-schemas.ts`
- Modify (barrel): `src/ast/index.ts`
- Test: `src/ast/header-footer-schemas.test.ts` (create)

**Interfaces:**
- Produces:
  - `HeaderFooterVariantSchema` / type `HeaderFooterVariant` — `{ header?, footer?, style? }.catchall(JsonValue)` (the v1 shape, reused for each page variant).
  - `PageNumberingModeSchema` = `z.enum(['continuous','restartPerSpec'])`; `PageNumberingSchema` = `{ mode, startAt? }.catchall(JsonValue)`.
  - `HeaderFooterCompositionSchema` extended with `variants?: { default?, first?, even? }`, `pageNumbering?`, `raw?` (open sidecar) — still `.catchall(JsonValue)`.
  - `defaultVariant(config: HeaderFooterComposition): HeaderFooterVariant` — returns `variants.default` if present, else the top-level v1 fields.

- [ ] **Step 1: Write the failing tests** (`src/ast/header-footer-schemas.test.ts`) covering the five spec invariants:
  1. v1 `{ header, footer, style }` validates; `defaultVariant` returns those fields.
  2. v2 `variants.default/first/even` validates and round-trips unknown keys (catchall + `raw`).
  3. `pageNumbering.mode ∈ {continuous, restartPerSpec}` with optional int `startAt`; bad mode/`startAt` type fails.
  4. Invalid known field kind (`header.left.content[].kind`) still fails (catchall doesn't swallow typed-field errors).
  5. `// KNOWN AMBIGUITY` — both top-level v1 fields and `variants.default` present → `defaultVariant` returns `variants.default`.

- [ ] **Step 2: Run `pnpm test` → tests fail** (symbols/behavior not yet present).

- [ ] **Step 3: Implement** the schema extension + `defaultVariant` in `header-footer-schemas.ts`; export the new symbols from `src/ast/index.ts`.

- [ ] **Step 4: Run `pnpm test` → green.** Then `pnpm lint` and `pnpm build` → green.

- [ ] **Step 5: Commit** `feat(ast): header/footer variants + page-number policy + raw sidecar`.

### Task 2: ADR-040

**Files:**
- Create: `docs/adr/040-header-footer-fidelity.md` (Status / Context / Decision / Consequences).

- [ ] Capture: variants/pageNumbering/raw-sidecar decision; v1→`default` backward-compat guarantee; the dead-039-reference note (039 is OCR provisioning; this ADR supersedes the phantom 039 cited by #302); even/first rendering gated on doc-level OOXML flags is deferred to #303/#306.
- [ ] Commit `docs(adr): ADR-040 header/footer fidelity`.
