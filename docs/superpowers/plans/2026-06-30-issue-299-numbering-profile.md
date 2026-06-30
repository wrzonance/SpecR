# #299 — Structural Numbering Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator declare a non-standard source's structural numbering scheme once at ingress as a saveable, library-scoped profile that deterministically overrides the 5-signal engine's numId→tier and style→`numPr` mapping.

**Architecture:** A `NumberingProfile` is the serializable, operator-editable projection of the parser's internal `NumberingMap` classification fields (`articleIlvl`, `pStyleToNumId`/`pStyleToIlvl`, `specShapedNumIds`) plus tier bounds and label templates. The parser stays pure: it gains an optional `numberingProfile` through `ParseOptions`; the API/ingress layer resolves `spec.numbering_profile_id ?? built-in CSI default` and injects it. A snapshot extractor serializes a parsed map *into* a profile; an apply step deserializes a profile *back into* an authoritative map — round-trip symmetric. Disagreements between profile and inference are recorded in `paragraphs.conflicts`, never dropped.

**Tech Stack:** TypeScript/Node 22 (ESM), Zod v4, Express, node-pg-migrate, PostgreSQL 16, vitest.

**Spec:** `docs/superpowers/specs/2026-06-29-issue-299-numbering-profile-design.md`

## Global Constraints

- **ESLint enforced:** `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400/file, `no-console` error, `no-explicit-any` error. No `!` outside tests.
- **TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.** Relative imports end in `.js`; type-only imports use `import type`. No `as unknown as`, no cross-boundary assertions.
- **Module boundaries hard:** import only from a sibling's barrel (`../db/index.js`, `../parser/index.js`, `../ast/index.js`) — never internals. `ast/` is foundational; `db/` and `parser/` depend on it, never the reverse.
- **Zod v4:** `z.uuid()`, not `z.string().uuid()`. Open JSONB schemas use `.catchall(z.json())` (ADR-021). `.exactOptional()` for optional keys.
- **Migrations reversible** (paired up/down); they are the schema of record, not test targets. **Next free number is `038`** (`037` is claimed by #98/PR #315).
- **Module errors:** throw `ParserError`/`GeneratorError` with `cause` chained; API middleware maps `ParserError`→422, conflict→409, unknown→500. Stack traces never leave the process.
- **`openapi.yaml` is CI-enforced truth** (contract gate `src/api/contract.integration.test.ts`): any route/method/shape/status change updates `openapi.yaml` **in the same task**.
- **Commit scope = module changed** (`feat(ast):`, `feat(db):`, `feat(parser):`, `feat(api):`).
- **Regression-test names state the symptom.** Genuinely ambiguous OOXML mappings get a `// KNOWN AMBIGUITY:` test.
- **Branch:** `feat/issue-299` (worktree `/home/adam/github/SpecR/.worktrees/feat/issue-299`). Never commit to main. Every PR draft. Commits: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Unit tests that import `db/` need env:** prefix `DATABASE_URL='postgres://specr:specr@localhost:5432/specr' NODE_ENV='test'` or `env.ts` `process.exit(1)`s.

---

## File structure

| File | Responsibility |
|---|---|
| `src/ast/numbering-profile-schema.ts` *(create)* | `NumberingProfileSchema` (Zod) + inferred types. Foundational. |
| `src/ast/index.ts` *(modify)* | Barrel-export the schema + types. |
| `src/db/migrations/038_create_numbering_profiles.ts` *(create)* | Table + `specs.numbering_profile_id` FK + seeded built-in default. |
| `src/db/queries/numbering-profiles.ts` *(create)* | CRUD + `getEffectiveNumberingProfile(specId)` + assign/clear. |
| `src/db/index.ts` *(modify)* | Barrel-export the query functions + row types. |
| `src/parser/docx/numbering-profile.ts` *(create)* | `extractNumberingProfile()` (snapshot) + `applyNumberingProfile()` (override), both pure. |
| `src/parser/docx/index.ts` *(modify)* | Thread optional profile into the parse pipeline; record disagreements. |
| `src/parser/index.ts` *(modify)* | Add `numberingProfile?` to `ParseOptions`; thread to docx path; export the two new pure fns + types. |
| `src/api/numbering-profiles.ts` *(create)* | Route handlers (library CRUD, spec assign/clear, snapshot). |
| `src/api/router.ts` *(modify)* | Register routes. |
| `src/ast/schemas.ts` (or where request-body schemas live) *(modify)* | `SetNumberingProfileBody` etc. |
| `openapi.yaml` *(modify)* | Document every new path/op/schema (Task 6). |
| `src/mcp/tools.ts` *(modify, optional Task 7)* | Read-only `get_numbering_profile`. |

---

## Task 1: `NumberingProfileSchema` in `ast/` (foundational)

**Files:**
- Create: `src/ast/numbering-profile-schema.ts`
- Modify: `src/ast/index.ts`
- Test: `src/ast/numbering-profile-schema.test.ts`

**Interfaces:**
- Produces:
  - `NumberingProfileSchema: z.ZodType` and `type NumberingProfile = z.infer<typeof NumberingProfileSchema>`.
  - Shape (open via `.catchall(z.json())` at every object level, ADR-021):
    - `tiers: { part: { numberStyle: 'integer'; maxCount: number /* ≤5 */ }; article?: TierShape; paragraph?: TierShape; subparagraph?: TierShape }`
    - `numbering: Array<{ numId: number; levels: Array<{ ilvl: number; tier: TierName; labelTemplate?: string; numFmt?: string }> }>`
    - `styleLadder: Array<{ styleId: string; numId: number; ilvl: number; tier: TierName }>`
    - `articleIlvl?: number` (the part/article offset; ARCAT=1, CPI=3)
  - `type TierName = 'part' | 'article' | 'paragraph' | 'subparagraph'`.

- [ ] **Step 1: Write failing tests** — `src/ast/numbering-profile-schema.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { NumberingProfileSchema } from './index.js';

describe('NumberingProfileSchema', () => {
  const valid = {
    tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
    numbering: [{ numId: 12, levels: [{ ilvl: 0, tier: 'part', labelTemplate: 'PART %1' }] }],
    styleLadder: [{ styleId: 'PART', numId: 12, ilvl: 0, tier: 'part' }],
    articleIlvl: 1,
  };

  it('accepts a well-formed profile and round-trips unknown keys', () => {
    const parsed = NumberingProfileSchema.parse({ ...valid, vendorX: { note: 'keep me' } });
    expect(parsed.tiers.part.maxCount).toBe(5);
    expect((parsed as Record<string, unknown>)['vendorX']).toEqual({ note: 'keep me' });
  });

  it('rejects a part tier with maxCount > 5 (CSI integer-part bound)', () => {
    expect(() => NumberingProfileSchema.parse({ ...valid, tiers: { part: { numberStyle: 'integer', maxCount: 6 } } })).toThrow();
  });

  it('rejects a non-integer part numberStyle', () => {
    expect(() => NumberingProfileSchema.parse({ ...valid, tiers: { part: { numberStyle: 'decimal', maxCount: 5 } } })).toThrow();
  });

  it('rejects an unknown tier name in a numbering level', () => {
    expect(() => NumberingProfileSchema.parse({ ...valid, numbering: [{ numId: 1, levels: [{ ilvl: 0, tier: 'chapter' }] }] })).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`NumberingProfileSchema` not exported)

Run: `DATABASE_URL='postgres://specr:specr@localhost:5432/specr' NODE_ENV='test' pnpm vitest run --project unit numbering-profile-schema`
Expected: FAIL — module/export not found.

- [ ] **Step 3: Implement** `src/ast/numbering-profile-schema.ts`

```typescript
import { z } from 'zod';

const JsonValue = z.json();

export const TierNameSchema = z.enum(['part', 'article', 'paragraph', 'subparagraph']);

const TierShapeSchema = z.object({ maxCount: z.number().int().positive().exactOptional() }).catchall(JsonValue);

// The PART tier is pinned to the CSI integer model: integer style, ≤5 parts.
const PartTierSchema = z
  .object({ numberStyle: z.literal('integer'), maxCount: z.number().int().min(1).max(5) })
  .catchall(JsonValue);

const NumberingLevelSchema = z
  .object({
    ilvl: z.number().int().min(0),
    tier: TierNameSchema,
    labelTemplate: z.string().exactOptional(),
    numFmt: z.string().exactOptional(),
  })
  .catchall(JsonValue);

export const NumberingProfileSchema = z
  .object({
    tiers: z.object({
      part: PartTierSchema,
      article: TierShapeSchema.exactOptional(),
      paragraph: TierShapeSchema.exactOptional(),
      subparagraph: TierShapeSchema.exactOptional(),
    }),
    numbering: z.array(z.object({ numId: z.number().int(), levels: z.array(NumberingLevelSchema) }).catchall(JsonValue)),
    styleLadder: z.array(
      z.object({ styleId: z.string(), numId: z.number().int(), ilvl: z.number().int().min(0), tier: TierNameSchema }).catchall(JsonValue)
    ),
    articleIlvl: z.number().int().min(0).exactOptional(),
  })
  .catchall(JsonValue);

export type TierName = z.infer<typeof TierNameSchema>;
export type NumberingProfile = z.infer<typeof NumberingProfileSchema>;
```

- [ ] **Step 4: Barrel-export** — add to `src/ast/index.ts`:

```typescript
export { NumberingProfileSchema, TierNameSchema } from './numbering-profile-schema.js';
export type { NumberingProfile, TierName } from './numbering-profile-schema.js';
```

- [ ] **Step 5: Run — expect PASS** (same command as Step 2). Then `pnpm lint`.

- [ ] **Step 6: Commit**

```bash
git add src/ast/numbering-profile-schema.ts src/ast/numbering-profile-schema.test.ts src/ast/index.ts
git commit -m "feat(ast): NumberingProfileSchema — structural numbering profile (#299)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Migration 038 — table + FK + built-in default

**Files:**
- Create: `src/db/migrations/038_create_numbering_profiles.ts`
- Test: `src/db/queries/numbering-profiles.integration.test.ts` (schema-level assertions; query logic lands in Task 3)

**Interfaces:**
- Produces: table `numbering_profiles(id, library_id, name, rules jsonb, created_at, updated_at)`; column `specs.numbering_profile_id uuid` FK → `numbering_profiles` ON DELETE RESTRICT, indexed; one seeded `library_id IS NULL` row named `'CSI Default'`; partial unique index enforcing the built-in singleton.

- [ ] **Step 1: Write the migration** (model on `024_create_editing_conventions.ts` + `027_spec_style_source.ts`)

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 scoped-profile pattern (mirrors editing_conventions #137). The built-in
// 'CSI Default' (library_id IS NULL) encodes the integer-PART, max-5 tier model so
// an unassigned spec resolves to today's engine behavior. Frozen snapshot — never
// imported from src/ runtime.
const CSI_DEFAULT_RULES = {
  tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
  numbering: [],
  styleLadder: [],
};

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('numbering_profiles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' }, // NULL = built-in default
    name: { type: 'text', notNull: true },
    rules: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('numbering_profiles', 'numbering_profiles_name_nonempty', "CHECK (length(trim(name)) > 0)");
  pgm.sql(`CREATE UNIQUE INDEX numbering_profiles_builtin_singleton
           ON numbering_profiles ((library_id IS NULL)) WHERE library_id IS NULL`);
  const literal = JSON.stringify(CSI_DEFAULT_RULES).replace(/'/g, "''");
  pgm.sql(`INSERT INTO numbering_profiles (library_id, name, rules)
           VALUES (NULL, 'CSI Default', '${literal}'::jsonb)`);

  pgm.addColumns('specs', {
    numbering_profile_id: { type: 'uuid', references: 'numbering_profiles', onDelete: 'RESTRICT' },
  });
  pgm.createIndex('specs', 'numbering_profile_id', { name: 'specs_numbering_profile_id_idx' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('specs', 'numbering_profile_id', { name: 'specs_numbering_profile_id_idx' });
  pgm.dropColumns('specs', ['numbering_profile_id']);
  pgm.dropTable('numbering_profiles');
};
```

- [ ] **Step 2: Run migration up→down→up clean**

Run: `pnpm migrate && pnpm migrate:down && pnpm migrate`
Expected: each direction succeeds; no error. (Confirms reversibility + seed insert.)

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/038_create_numbering_profiles.ts
git commit -m "feat(db): numbering_profiles table + specs FK + CSI default (#299)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: DB queries + resolution

**Files:**
- Create: `src/db/queries/numbering-profiles.ts`
- Modify: `src/db/index.ts`
- Test: `src/db/queries/numbering-profiles.integration.test.ts`

**Interfaces:**
- Consumes: `NumberingProfile`, `NumberingProfileSchema` from `../../ast/index.js`.
- Produces (all `import`-able from `../db/index.js`):
  - `interface NumberingProfileRow { id: string; libraryId: string | null; name: string; rules: NumberingProfile }`
  - `listNumberingProfiles(libraryId: string): Promise<NumberingProfileRow[]>` — library rows + the built-in default.
  - `getNumberingProfile(id: string): Promise<NumberingProfileRow | null>`
  - `createNumberingProfile(libraryId: string, name: string, rules: NumberingProfile): Promise<NumberingProfileRow>`
  - `updateNumberingProfile(id: string, patch: { name?: string; rules?: NumberingProfile }): Promise<NumberingProfileRow | null>`
  - `deleteNumberingProfile(id: string): Promise<boolean>` — pg `23503` (RESTRICT) surfaces to caller as a 409.
  - `setSpecNumberingProfile(specId: string, profileId: string): Promise<boolean>` / `clearSpecNumberingProfile(specId: string): Promise<boolean>`
  - `getEffectiveNumberingProfile(specId: string): Promise<NumberingProfile>` — resolves `spec.numbering_profile_id`, else the built-in `'CSI Default'`. Always returns a profile (never null) so callers have a deterministic default. Validates `rules` through `NumberingProfileSchema` (chain `ZodError` as `DatabaseError` cause on failure).

- [ ] **Step 1: Write failing integration tests** — assert: (a) `getEffectiveNumberingProfile` returns the CSI default when a spec has no assignment; (b) assign then resolve returns the assigned profile; (c) `deleteNumberingProfile` on a referenced profile throws pg `23503`; (d) `listNumberingProfiles` includes the built-in default. (Use the existing integration harness in `conventions.integration.test.ts` as the pattern — real Postgres, `beforeEach` truncate/seed.)

- [ ] **Step 2: Run — expect FAIL** (`pnpm test:integration numbering-profiles`).

- [ ] **Step 3: Implement** `numbering-profiles.ts` mirroring `conventions.ts` (library-scoped + NULL default) and `style-source.ts` (assign/clear). Parse `rules` through `NumberingProfileSchema` on read; wrap errors in `DatabaseError` with `cause`. Keep each function ≤50 lines (extract a `rowToProfile` mapper).

- [ ] **Step 4: Barrel-export** the functions + `NumberingProfileRow` from `src/db/index.ts`.

- [ ] **Step 5: Run — expect PASS**; `pnpm lint`.

- [ ] **Step 6: Commit** `feat(db): numbering-profile queries + effective-profile resolution (#299)`.

---

## Task 4: Snapshot extractor (pure)

**Files:**
- Create: `src/parser/docx/numbering-profile.ts`
- Modify: `src/parser/index.ts` (export the pure fns + `NumberingProfile` re-export from ast)
- Test: `src/parser/docx/numbering-profile.test.ts`

**Interfaces:**
- Consumes: `NumberingMap` (`./types.js`), `StyleMap` (`./types.js`), `NumberingProfile`/`TierName` (`../../ast/index.js`).
- Produces:
  - `extractNumberingProfile(map: NumberingMap, styles: StyleMap): NumberingProfile` — serialize `map.articleIlvl`, the `pStyleToNumId`/`pStyleToIlvl` ladders → `styleLadder`, `abstractNums`/`nums` + `lvlText` → `numbering[].levels[].labelTemplate`/`numFmt`, `specShapedNumIds` → per-level `tier` assignment, with `tiers.part = { numberStyle: 'integer', maxCount: 5 }`. Pure; no I/O.

- [ ] **Step 1: Write failing test** — build a small `NumberingMap` fixture (one spec-shaped numId with ilvl 0=part, 1=article) and assert `extractNumberingProfile` emits a profile whose `styleLadder` + `numbering` + `articleIlvl` round-trip the map's classification fields. Include an ARCAT-derived and a CPI-derived case (CPI `articleIlvl=3`).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `extractNumberingProfile`. Derive `tier` per level from `articleIlvl` + `specShapedNumIds` (ilvl < articleIlvl ⇒ `part`; == articleIlvl ⇒ `article`; etc.). Map `lvlText` → `labelTemplate`, `numFmt` → `numFmt`.

- [ ] **Step 4: Run — expect PASS**; `pnpm lint`.

- [ ] **Step 5: Commit** `feat(parser): numbering-profile snapshot extractor (#299)`.

---

## Task 5: Apply/override + thread through parse + record conflicts (the core invariant)

**Files:**
- Modify: `src/parser/docx/numbering-profile.ts` (add `applyNumberingProfile`)
- Modify: `src/parser/docx/index.ts` (thread profile after `buildNumberingMap`/`withArticleIlvl`; record disagreements)
- Modify: `src/parser/index.ts` (`ParseOptions.numberingProfile?: NumberingProfile`; pass to docx path)
- Test: `src/parser/docx/numbering-profile-apply.test.ts` + golden assertions in the existing ARCAT/CPI inference tests

**Interfaces:**
- Consumes: `NumberingMap`, `NumberingProfile`.
- Produces:
  - `applyNumberingProfile(base: NumberingMap, profile: NumberingProfile): NumberingMap` — returns a new map (immutability) with `articleIlvl`, `pStyleToNumId`/`pStyleToIlvl`, `specShapedNumIds` taken from the profile when present; falls back to `base` fields the profile does not specify. Pure.
  - `ParseOptions` gains `numberingProfile?: NumberingProfile`. When absent, the pipeline is byte-for-byte unchanged.
  - Disagreement recording: where a profile-driven resolved tier differs from the un-profiled classification for a paragraph, append a `SignalConflict` to that paragraph's `conflicts` (existing `meta.conflicts` channel) — losing signal persisted, not dropped.

- [ ] **Step 1: Write the HARD backward-compat test first** — `numbering-profile-apply.test.ts`:

```typescript
// Absent a profile, the produced AST is byte-for-byte today's behavior.
import { describe, it, expect } from 'vitest';
import { parse } from '../index.js';
import { readFixture } from '../../test-utils/fixtures.js'; // use the existing fixture helper

describe('#299 numbering profile — backward compat', () => {
  it('no profile: ARCAT fixture parses to the unchanged baseline tree', async () => {
    const buf = await readFixture('arcat/clean-section.docx');
    const without = await parse(buf, 'clean-section.docx');
    const explicitDefault = await parse(buf, 'clean-section.docx', { numberingProfile: undefined });
    expect(explicitDefault).toEqual(without); // identity — no behavior change
  });
});
```

(Adapt fixture paths/helpers to the repo's actual ARCAT + CPI fixtures used by the current inference tests.)

- [ ] **Step 2: Run — expect FAIL** (ParseOptions has no `numberingProfile`).

- [ ] **Step 3: Implement** `applyNumberingProfile` + thread the optional profile through `parseDocxBuffer` → after `withArticleIlvl`, if `options.numberingProfile` is present, `resolvedNumberingMap = applyNumberingProfile(resolvedNumberingMap, profile)`. Classify once with the resolved map; when a profile is present, also classify with the base map and diff per-paragraph resolved tier to emit `SignalConflict`s. Keep `classifyParagraphs` signature unchanged (inject via the map, not a new param) so existing callers/tests are untouched.

- [ ] **Step 4: Add the override + conflict tests** — a deliberately non-standard fixture (or synthetic `NumberingMap`) + a profile that declares different tiers ⇒ deterministic profile tiers in the tree; a profile that disagrees with inference ⇒ the losing signal appears in `meta.conflicts`. Mark any genuinely ambiguous mapping `// KNOWN AMBIGUITY:`.

- [ ] **Step 5: Run full parser suite — expect PASS** including the existing ARCAT/CPI golden tests (the regression guard).

Run: `DATABASE_URL='postgres://specr:specr@localhost:5432/specr' NODE_ENV='test' pnpm vitest run --project unit parser`
Expected: PASS, existing inference goldens unchanged.

- [ ] **Step 6: Commit** `feat(parser): apply numbering profile as deterministic override + conflicts (#299)`.

---

## Task 6: REST API + `openapi.yaml` (same task)

**Files:**
- Create: `src/api/numbering-profiles.ts`
- Modify: `src/api/router.ts`, request-body schema module (`src/ast/schemas.ts` or wherever `SetStyleSourceBody` lives), `openapi.yaml`
- Test: `src/api/numbering-profiles.integration.test.ts` (+ the contract gate runs automatically)

**Interfaces:**
- Endpoints (all return `ApiResponse<T>`; UUID-validate params; pre-check existence → 404; pg `23503` on delete → 409):
  - `GET /libraries/:id/numbering-profiles` → `NumberingProfileRow[]`
  - `POST /libraries/:id/numbering-profiles` `{ name, rules }` (body via `validateBody(CreateNumberingProfileBodySchema)`; `rules` = `NumberingProfileSchema`) → row
  - `GET /numbering-profiles/:id` → row | 404
  - `PATCH /numbering-profiles/:id` `{ name?, rules? }` → row | 404
  - `DELETE /numbering-profiles/:id` → 204 | 409 (referenced)
  - `PUT /specs/:id/numbering-profile` `{ profileId }` → `{ profileId, name }` | 404
  - `DELETE /specs/:id/numbering-profile` → 204 | 404
  - `GET /specs/:id/numbering-profile/snapshot` → `NumberingProfile` (parse the spec's source, run `extractNumberingProfile`; 404 if spec/source absent)

- [ ] **Step 1: Write failing integration tests** for each endpoint (happy path + 404 + the 409-on-referenced-delete + snapshot returns a valid profile). Model on `style-source.integration.test.ts` + `templates-crud.integration.test.ts`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement handlers** in `numbering-profiles.ts` (mirror `style-source.ts`'s UUID-parse + pre-check + pg-code mapping). Register in `router.ts`. Add body schemas.
- [ ] **Step 4: Update `openapi.yaml`** — add the 8 operations + the `NumberingProfile` component schema + reuse the standard `ApiResponse`/error responses. (Contract gate fails the build if any route/op/shape is undocumented or mismatched.)
- [ ] **Step 5: Run — expect PASS**, including `pnpm test:integration contract`. Then `pnpm lint && pnpm build`.
- [ ] **Step 6: Commit** `feat(api): numbering-profile CRUD + spec assignment + snapshot (#299)`.

---

## Task 7 (optional, spec marks it nice-to-have): MCP read tool

**Files:** Modify `src/mcp/tools.ts`; test `src/mcp/*.test.ts`.

**Interfaces:** read-only tool `get_numbering_profile({ spec_id })` → the effective profile via `getEffectiveNumberingProfile`. MCP tools never throw — return `{ isError: true, content: [...] }` on failure; import DB fns from `../db/index.js`; `z.uuid()`.

- [ ] Steps: failing test → implement (mirror an existing read tool like `get_paragraph`) → pass → `pnpm lint` → commit `feat(mcp): get_numbering_profile read tool (#299)`.

> Build the first six tasks; treat Task 7 as a follow-up if scope/time is tight (the spec lists MCP read as optional, write tools as out of scope).

---

## Self-Review

- **Spec coverage:** §Data model → Tasks 1–3; §Ingress flow snapshot → Task 4; §Inference integration (override + conflicts + pure-parser injection) → Task 5; §API surface + openapi → Task 6; MCP read (optional) → Task 7; §Testing invariants → distributed (backward-compat golden = Task 5 Step 1, RESTRICT-409 = Task 3/6, part-bound rejection = Task 1, conflict-surfacing = Task 5). Deferred items (firm/client tiers, UI, write-tools, auto-detect) are not tasked — correct.
- **Type consistency:** `NumberingProfile`/`TierName` defined in Task 1, consumed by name in Tasks 3–7; `NumberingProfileRow` defined in Task 3, consumed in Task 6; `extractNumberingProfile`/`applyNumberingProfile` defined Tasks 4/5, consumed Tasks 5/6. `getEffectiveNumberingProfile` (Task 3) consumed by Tasks 6–7. Names align.
- **No placeholders:** foundational schema, migration, and the core backward-compat test carry full code; query/handler tasks carry exact signatures + the precedent file to mirror (this codebase's house style — `style-source.ts`/`conventions.ts` are the literal templates).
- **Green between steps:** Tasks 1→3 are additive (no behavior change); Task 5 is gated by the byte-for-byte identity test; openapi lands with its routes (Task 6) so the contract gate never goes red mid-PR.
