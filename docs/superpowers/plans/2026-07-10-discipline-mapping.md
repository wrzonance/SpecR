# Discipline Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the API a first-class notion of engineering discipline (Electrical, HVAC, Plumbing…) so clients can filter spec listings by discipline and read each spec's resolved discipline instead of hard-coding a division→discipline table.

**Architecture:** A global `disciplines` catalog plus a library-scoped `discipline_section_rules` table following the existing scoped-profile pattern (built-in default rows have `library_id IS NULL`; a library's own rows override wholesale, exactly like `editing_conventions`). Rules map an inclusive CSI **division range** (2-digit) to a discipline. Resolution: a library with any rules uses only its own; otherwise it inherits the built-in default. Spec listings resolve each row's discipline in SQL by joining the spec's division against the effective rule set.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, PostgreSQL (node-pg-migrate), MCP (@modelcontextprotocol/sdk), vitest.

## Global Constraints

- Migration number is **044** (`src/db/migrations/044_create_disciplines.ts`). Never 043 (reserved for #446).
- ADR number is **ADR-065** (`docs/adr/065-discipline-mapping.md`).
- Append-only, no reordering, in the files a parallel agent also edits: `openapi.yaml`, `src/mcp/contract-map.ts`, `src/mcp/capabilities.ts`, and the `src/db/index.ts` barrel.
- ESLint enforced: `complexity` ≤10, `sonarjs/cognitive-complexity` ≤10, `max-lines-per-function` ≤50, `max-lines` ≤400, no `console`, no `any`, no `as unknown as`, no non-null `!` outside tests.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (relative imports end `.js`; type-only imports use `import type`).
- Zod at every external boundary; `z.uuid()` not `z.string().uuid()`.
- Typed module errors extending `DatabaseError`; chain `cause`.
- `openapi.yaml` updated in the SAME PR (contract gate is CI-enforced). MCP tools contract-bound to REST ops (ADR-044) with capability tiers (ADR-045).
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Design decisions (documented in ADR-065 + PR)

1. **Rules match at CSI division granularity (2-digit), as an inclusive range** `[divisionStart, divisionEnd]`. A single division has start == end (the issue's "prefix"); multiple divisions are a "range". Division IS the 2-digit prefix of a section number and is the CSI-standard discipline boundary, so this satisfies "section prefix or range" without lexicographic string-range ambiguity.
2. **Default 21/22/23 split = CSI-accurate:** 21→Fire Suppression, 22→Plumbing, 23→HVAC (plus 25→Integrated Automation for I&C, 26→Electrical, 27→Communications, 28→Electronic Safety & Security). The issue delegated this split. A firm that groups all mechanical trades under one "Mechanical" discipline overrides with a range rule `21–23 → Mechanical` — the exact per-library override this feature ships, so the ambiguity becomes a demonstration of it. "Mechanical" is seeded in the catalog (unmapped by default) so it's available as an override target.
3. **Disciplines are a global catalog** (no `library_id`); overrides remap divisions to existing catalog disciplines. Adding a brand-new discipline is a documented future enhancement (there is no add-discipline endpoint in scope).
4. **Library override is all-or-nothing** (mirrors `editing_conventions`): a library with ≥1 rule uses only its rules; else it inherits the built-in default. `PUT` replaces the set (≥1 rule); `DELETE` clears the override (reverts to built-in).
5. **`GET /projects/{id}/specs` is added** (only POST/DELETE existed). Project spec copies have `library_id IS NULL`, and a project may draw from several libraries, so project-listing disciplines resolve against the **built-in default** (no library lens) — deterministic and unambiguous. Per-library override is exercised on the library listing.
6. **Row `discipline` field is the discipline `key`** (slug, e.g. `electrical`) or `null` when the division is unmapped. Clients resolve key→display name + rules via `GET /disciplines`.

## File Structure

- `src/db/migrations/044_create_disciplines.ts` — tables + seed (paired down).
- `src/ast/discipline-schemas.ts` — Zod schemas for rules + write body; exported via `src/ast/index.ts`.
- `src/db/queries/disciplines.ts` — resolution chain + rule-set write/clear + discipline-annotated listings helpers. Exported via `src/db/index.ts` (append).
- `src/db/queries/libraries.ts` — extend `listLibrarySpecs` with discipline field + filter.
- `src/db/queries/projects.ts` — new `listProjectSpecs` with discipline field + filter.
- `src/api/disciplines.ts` — handlers: `GET /disciplines`, `PUT`/`DELETE /libraries/:id/disciplines`.
- `src/api/libraries.ts` — thread `discipline` query param into `listLibrarySpecsHandler`.
- `src/api/projects.ts` — new `listProjectSpecsHandler`.
- `src/api/router.ts` — register the four routes.
- `src/mcp/discipline-handlers.ts` + `src/mcp/discipline-tools.ts` — `list_disciplines`, `set_library_disciplines`, `clear_library_disciplines`, `list_project_specs`; thread `discipline` into `list_library_specs`.
- `src/mcp/tools.ts` — register discipline tools.
- `src/mcp/contract-map.ts`, `src/mcp/capabilities.ts` — append parity + tier entries.
- `openapi.yaml` — new ops, params, schemas (append).
- `docs/adr/065-discipline-mapping.md` — the ADR.
- Tests: `src/db/queries/disciplines.integration.test.ts`, `src/api/disciplines.integration.test.ts`, plus assertions folded into existing library/project listing tests.

---

### Task 1: Migration 044 — tables + seed

**Files:** Create `src/db/migrations/044_create_disciplines.ts`.

- `disciplines`: `id uuid pk`, `key text unique notNull`, `name text notNull`, `created_at`. CHECK key/name non-empty.
- `discipline_section_rules`: `id uuid pk`, `discipline_id uuid notNull → disciplines ON DELETE CASCADE`, `library_id uuid → libraries ON DELETE CASCADE` (NULL = built-in default), `division_start char(2) notNull`, `division_end char(2) notNull`. CHECK `division_start <= division_end` and both `~ '^\d{2}$'`. Index on `library_id`. Partial unique index preventing duplicate `(library_id, division_start, division_end)`.
- Seed catalog (global): fire-suppression, plumbing, hvac, mechanical, integrated-automation, electrical, communications, electronic-safety-security.
- Seed built-in default rules (`library_id NULL`): 21→fire-suppression, 22→plumbing, 23→hvac, 25→integrated-automation, 26→electrical, 27→communications, 28→electronic-safety-security.
- `down`: drop both tables.

Verify: `pnpm migrate` then `pnpm migrate:down` then `pnpm migrate` round-trips clean against the isolated DB.

### Task 2: Zod schemas

**Files:** Create `src/ast/discipline-schemas.ts`; export from `src/ast/index.ts`.

- `DivisionSchema = z.string().regex(/^\d{2}$/)`.
- `DisciplineRuleInputSchema = z.object({ discipline: z.string().min(1), divisionStart: DivisionSchema, divisionEnd: DivisionSchema })` refined `divisionStart <= divisionEnd`.
- `SetDisciplinesBodySchema = z.object({ rules: z.array(DisciplineRuleInputSchema).min(1) })` refined: no overlapping division ranges (sort by start, each start > previous end) → else issue.
- Export inferred types.

### Task 3: Resolution chain + writes (`src/db/queries/disciplines.ts`)

**Interfaces produced (exact):**
- `interface DisciplineRule { discipline: string; divisionStart: string; divisionEnd: string }`
- `interface ResolvedDiscipline { id: string; key: string; name: string; rules: readonly DisciplineRule[] }`
- `interface ResolvedDisciplines { disciplines: readonly ResolvedDiscipline[]; inherited: boolean }`
- `listDisciplines(libraryId?: string, db?): Promise<ResolvedDisciplines>` — all catalog disciplines, each with its rules from the effective set; `inherited` true when the effective set is the built-in default.
- `replaceLibraryDisciplineRules(libraryId, rules, db?): Promise<void>` — atomic delete-all-then-insert of the library's rows; validates each `discipline` key exists (else `DisciplineNotFoundError`).
- `clearLibraryDisciplineRules(libraryId, db?): Promise<boolean>` — delete the library's rows; true when ≥1 removed.
- `class DisciplineNotFoundError extends DatabaseError`.
- A shared SQL fragment / helper `effectiveRulesCte(libraryParam)` reused by the listings for the `library-own-else-builtin` selection, keyed on `substr(section,1,2) BETWEEN division_start AND division_end`.

### Task 4: Discipline-annotated listings

**Files:** `src/db/queries/libraries.ts` (`listLibrarySpecs` + `discipline?` filter, `discipline` on `LibrarySpec`), `src/db/queries/projects.ts` (new `listProjectSpecs(projectId, discipline?, db?)` returning TOC rows + `discipline`, resolved against built-in default).

### Task 5: REST handlers + routes + openapi

**Files:** `src/api/disciplines.ts`, `src/api/libraries.ts`, `src/api/projects.ts`, `src/api/router.ts`, `openapi.yaml`.
- `GET /disciplines?libraryId=` → `{ data: ResolvedDiscipline[], meta: { inherited } }`.
- `PUT /libraries/:id/disciplines` (SetDisciplinesBody) → replace; 404 unknown library, 422 unknown discipline key / bad body.
- `DELETE /libraries/:id/disciplines` → clear override (200 always when library exists; 404 unknown library).
- `GET /libraries/:id/specs?discipline=` and new `GET /projects/:id/specs?discipline=` carry `discipline` on rows.

### Task 6: MCP tools + parity

**Files:** `src/mcp/discipline-handlers.ts`, `src/mcp/discipline-tools.ts`, `src/mcp/tools.ts`, `src/mcp/contract-map.ts` (append), `src/mcp/capabilities.ts` (append).
- `list_disciplines` (read), `set_library_disciplines` (write), `clear_library_disciplines` (write), `list_project_specs` (read); `discipline` param added to `list_library_specs`.
- Contract-map: `get /disciplines`→`list_disciplines`, `get /projects/{}/specs`→`list_project_specs`, `put /libraries/{}/disciplines`→`set_library_disciplines`, `delete /libraries/{}/disciplines`→`clear_library_disciplines`.

### Task 7: ADR + docs + final verification

**Files:** `docs/adr/065-discipline-mapping.md`; run `pnpm lint`, `pnpm test`, targeted integration (`disciplines`, `libraries`, `projects`, both contract gates).

---

## Self-Review

- Spec coverage: migration+seed (T1), resolution chain (T3), GET /disciplines + discipline filter/field on both listings (T4/T5), rule CRUD (T3/T5), MCP tool+parity (T6), tests (each task) — all mapped.
- Acceptance: (1) default filter via seeded CSI divisions → T1+T4; (2) per-library override isolation → T3+T5 tests; (3) rows carry resolved discipline → T4.
