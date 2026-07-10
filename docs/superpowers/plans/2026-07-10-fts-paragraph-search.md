# Ranked Full-Text Paragraph Search Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Implement task-by-task, keeping the build green (lint + unit + touched integration files + both contract gates) between tasks.

**Goal:** Replace the ILIKE `searchParagraphs` with ranked PostgreSQL full-text search (tsvector + `websearch_to_tsquery` + `ts_rank_cd` + `ts_headline`), expose it as `GET /search`, and bring MCP `search_library` to parity.

**Architecture:** A STORED generated `tsvector` column on `paragraphs` (English config) backed by a GIN index makes ranked FTS fast and consistent with `text` without a trigger. `searchParagraphs` becomes an options-based ranked query with scope filters (library / project / division / part / nodeType). A new `GET /search` REST route pairs with the existing MCP tool, and the contract map is updated so both gates stay green.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, node-pg (`pool`), node-pg-migrate, PostgreSQL 16, vitest.

## Global Constraints

- ESLint enforced: `complexity` 10, `sonarjs/cognitive-complexity` 10, `max-lines-per-function` 50, `max-lines` 400, `no-console` + `no-explicit-any` = error.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (no explicit `undefined` on optional props — use conditional spread), `verbatimModuleSyntax` (relative imports end `.js`; type-only imports use `import type`).
- No `any`, no `as unknown as`, no non-null `!` outside tests. Zod v4 `z.uuid()`.
- Module-barrel imports only (`../db/index.js`, never `../db/queries/search.js` from another module).
- `openapi.yaml` is authoritative — any route change updates it in the same PR (contract gate).
- Migrations reversible (paired up/down). Parameterized SQL only.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Conventional Commits, scope = module.
- ADR-062 (centrally assigned) documents the retrieval stance.

---

## File Structure

- `docs/adr/062-full-text-retrieval-stance.md` — ADR (new).
- `src/db/migrations/042_paragraphs_search_vector.ts` — generated tsvector + GIN index (new).
- `src/db/queries/search-query.ts` — pure SQL builder for the ranked query (new).
- `src/db/queries/search.ts` — `searchParagraphs` rewrite + types + `toSearchOptions` (modify).
- `src/db/queries/search.integration.test.ts` — rewrite for FTS ranking/filters/degenerate (modify).
- `src/db/index.ts` — export the new option type + helper (modify).
- `src/api/search.ts` — `GET /search` handler (new).
- `src/api/router.ts` — wire the route (modify).
- `src/api/search.integration.test.ts` — route behavior + response envelope (new).
- `src/api/contract.integration.test.ts` — response coverage for `get /search` (modify).
- `openapi.yaml` — `/search` path + `SearchHit` schema (modify).
- `src/mcp/tools.ts` — `search_library` inputSchema parity filters (modify).
- `src/mcp/handlers.ts` — `handleSearchLibrary` passes new options (modify).
- `src/mcp/contract-map.ts` — map `get /search` → `search_library`; drop from `MCP_NATIVE`; add to `INV5_READ_PENDING` (modify).

---

### Task 1: ADR-062 + migration (tsvector column + GIN index)

**Files:**
- Create: `docs/adr/062-full-text-retrieval-stance.md`
- Create: `src/db/migrations/042_paragraphs_search_vector.ts`

**Interfaces:**
- Produces: column `paragraphs.search_vector tsvector` (STORED generated from `text`, English), index `paragraphs_search_vector_gin`.

- [ ] **Step 1: Write the ADR** — Status/Context/Decision/Consequences: FTS is in-core and deterministic; embeddings/pgvector explicitly deferred to a future ADR; ts_rank_cd chosen for proximity; search does not filter `vanish` (retrieval surfaces all stored content; suppression is a render concern).
- [ ] **Step 2: Write the migration** (raw SQL for the generated column; `createIndex` gin):
```ts
import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(
    `ALTER TABLE paragraphs
       ADD COLUMN search_vector tsvector
       GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED`
  );
  pgm.createIndex('paragraphs', 'search_vector', {
    name: 'paragraphs_search_vector_gin',
    method: 'gin',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('paragraphs', 'search_vector', { name: 'paragraphs_search_vector_gin' });
  pgm.dropColumns('paragraphs', ['search_vector']);
};
```
- [ ] **Step 3: Run** `pnpm migrate` then `pnpm migrate:down` then `pnpm migrate` — verify up/down/up all clean.
- [ ] **Step 4: Commit** `feat(db): add FTS tsvector column + GIN index on paragraphs (ADR-062)`

### Task 2: Ranked `searchParagraphs` + SQL builder

**Files:**
- Create: `src/db/queries/search-query.ts`
- Modify: `src/db/queries/search.ts`, `src/db/index.ts`
- Test: `src/db/queries/search.integration.test.ts` (rewrite)

**Interfaces:**
- Produces:
  - `interface ParagraphSearchResult { paragraphId; text; nodeType; specId; specSection; specTitle; snippet: string; rank: number }`
  - `interface ParagraphSearchOptions { readonly libraryId?; projectId?; division?; part?: number; nodeType?; limit?: number }`
  - `searchParagraphs(query: string, options?: ParagraphSearchOptions): Promise<ParagraphSearchResult[]>`
  - `toSearchOptions(input): ParagraphSearchOptions` (omit-undefined constructor, exported for REST + MCP)
  - `buildParagraphSearch(query, options): { sql: string; params: readonly unknown[] }` (in search-query.ts)

- [ ] **Step 1: Failing tests** — rewrite `search.integration.test.ts`: seed a spec with a 3-part tree containing a tight-cluster paragraph, a scattered paragraph, plus a Products-part paragraph. Tests: (a) natural-language query returns the matching hit with `snippet`/`rank`; (b) tight-cluster ranks above scattered (`ts_rank_cd`); (c) division filter; (d) `part` filter returns only Products-part hits; (e) `nodeType` filter; (f) empty/whitespace query → `[]`; (g) degenerate all-stopword query falls back to ILIKE.
- [ ] **Step 2: Run** `pnpm exec vitest run --project integration src/db/queries/search.integration.test.ts` — expect FAIL (snippet/rank/options absent).
- [ ] **Step 3: Implement** `search-query.ts` (`WITH RECURSIVE q, hits` CTEs; degenerate ILIKE fallback via `numnode`; conditional scope clauses; conditional part climb→root→part_no CTEs) and rewrite `searchParagraphs` (early `return []` on blank query; `try/catch` → `DatabaseError`). Export types + `toSearchOptions` from `search.ts` and re-export via `db/index.ts`.
- [ ] **Step 4: Run** the same test — expect PASS. Run `pnpm lint`.
- [ ] **Step 5: Commit** `feat(db): ranked full-text searchParagraphs with scope filters + snippets`

### Task 3: `GET /search` REST route + openapi

**Files:**
- Create: `src/api/search.ts`, `src/api/search.integration.test.ts`
- Modify: `src/api/router.ts`, `openapi.yaml`, `src/api/contract.integration.test.ts`

**Interfaces:**
- Consumes: `searchParagraphs`, `toSearchOptions` from `../db/index.js`; `NodeTypeSchema` from `../ast/index.js`.
- Produces: `searchHandler(req, res)`; route `GET /search`; response `{ success: true, data: SearchHit[] }`.

- [ ] **Step 1: Failing test** — `search.integration.test.ts`: boot express app with `router`, seed a paragraph, `GET /search?q=...` → 200 `{success,data:[...]}` with snippet/rank; missing `q` → 400; `part`/`division` scoping.
- [ ] **Step 2: Run** `pnpm exec vitest run --project integration src/api/search.integration.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `search.ts` (Zod query schema: `q` min 1, `libraryId`/`projectId` uuid, `division` `^\d{2}$`, `part` coerce int 1–3, `nodeType` NodeTypeSchema, `limit` coerce int 1–100; 400 on parse fail; 500 on error via logger). Wire `router.get('/search', searchHandler)`. Add `/search` GET + `SearchHit` schema to `openapi.yaml`. Add `get /search` to `RESPONSE_COVERED` + a fetch assertion in `contract.integration.test.ts`.
- [ ] **Step 4: Run** `pnpm exec vitest run --project integration src/api/search.integration.test.ts src/api/contract.integration.test.ts` — expect PASS. `pnpm lint`.
- [ ] **Step 5: Commit** `feat(api): GET /search ranked full-text route + openapi`

### Task 4: MCP `search_library` parity + contract map

**Files:**
- Modify: `src/mcp/tools.ts`, `src/mcp/handlers.ts`, `src/mcp/contract-map.ts`
- Test: `src/mcp/contract.integration.test.ts` (gate) + `src/mcp/server.integration.test.ts` (existing search cases keep passing)

**Interfaces:**
- Consumes: `searchParagraphs`, `toSearchOptions`.
- Produces: `search_library` tool accepts `{ query, libraryId?, projectId?, division?, part?, nodeType?, limit }`; `OP_TO_TOOL` gains `get /search → search_library`.

- [ ] **Step 1:** Add parity filters to the `search_library` inputSchema in `tools.ts`; update `handleSearchLibrary` to accept + forward them via `toSearchOptions`.
- [ ] **Step 2:** In `contract-map.ts`: add `['get /search', 'search_library']` to `OP_TO_TOOL`; remove `'search_library'` from `MCP_NATIVE`; add `'search_library'` to `INV5_READ_PENDING` (needs seeded paragraph content beyond `pnpm seed`).
- [ ] **Step 3: Run** `pnpm exec vitest run --project integration src/mcp/contract.integration.test.ts src/mcp/server.integration.test.ts` — expect PASS (INV-1/2/2b/3/5 green; existing search cases green).
- [ ] **Step 4: Run** full green bar: `pnpm lint`, `pnpm test`, then the touched integration files + both contract gates.
- [ ] **Step 5: Commit** `feat(mcp): search_library FTS parity filters + contract-map REST twin`

---

## Self-Review

- Spec coverage: migration (T1), `searchParagraphs` rewrite + snippets + filters (T2), `GET /search` + openapi (T3), MCP upgrade + contract-map (T4), ADR (T1), ranking/scope/degenerate tests (T2), integration vs seeded corpus (T2/T3). All issue tasks mapped.
- Design decisions to document in PR: `ts_rank_cd` over plain `ts_rank` (proximity → "exact-phrase beats scattered"); no `vanish` filter (retrieval vs render); `part` = enclosing PART ordinal 1/2/3 via ancestor climb; snippet delimiters `<mark>`/`</mark>`; MCP response stays backward-compatible (snippet/rank are additive).
