# First-Class Clients (#391) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `clients` organizational entity (table + REST + MCP) and let a project be associated with / disassociated from a client, lifting the ADR-025 deferral.

**Architecture:** New `clients` table (migration 040) linked optionally to a client-tier master library (`library_id`, SET NULL) and referenced by `projects.client_id` (RESTRICT). A new `src/db/queries/clients.ts` query module owns create/list/get; `projects.ts` gains `clientId` handling on its update path and `clientId`/`clientName` on `ProjectSummary`. REST router exposes `POST/GET /clients` + `GET /clients/{id}`; `PATCH /projects/{id}` accepts `clientId`. MCP mirrors with `list_clients`/`get_client` (read) + `create_client` (write); the existing `update_project` tool gains `clientId`. Both contract gates stay green.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, pg, node-pg-migrate, vitest, `@modelcontextprotocol/sdk`.

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400/file, `no-console` error, `no-explicit-any` error.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (`import type` for types, `.js` relative import extensions).
- No `!` non-null assertions outside tests; no `as unknown as`; no type assertions across module boundaries.
- Module boundaries: import only from a sibling module's `index.ts` barrel. Within `db/queries` files import each other directly (established pattern).
- `openapi.yaml` is authoritative; any route change updates it in the same PR. MCP tool surface is contract-bound (ADR-044) — every user-facing op maps to a tool or `MCP_UNEXPOSED`.
- MCP tools never throw — return `{ isError: true, ... }`. Use `z.uuid()` (Zod v4). Import DB functions from `../db/index.js`.
- Migrations reversible (paired up/down). DB integration tests run against real Postgres (`postgres://specr:specr@localhost:5435/specr`, container `specr-pg-issue-391`).
- Commit scope = module changed. Commits co-authored by Claude Fable 5.

---

### Task 1: Migration `040_create_clients.ts`

**Files:**
- Create: `src/db/migrations/040_create_clients.ts`

**Interfaces:**
- Produces: `clients` table (`id uuid PK`, `name text NOT NULL UNIQUE`, `library_id uuid NULL REFERENCES libraries(id) ON DELETE SET NULL`, `created_at`, `updated_at`); `projects.client_id uuid NULL REFERENCES clients(id) ON DELETE RESTRICT` + index `projects_client_id_idx`.

- [ ] **Step 1: Write the migration** (mirrors `037_create_keynotes.ts` / `038_create_numbering_profiles.ts` house style)

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

// First-class client organizational entity (ADR-054, lifts ADR-025 deferral).
// clients is a LINK, not a merge: library_id optionally points at the client's
// client-tier master library (ON DELETE SET NULL — an optional cross-reference,
// the client stays valid without it). projects.client_id is RESTRICT — a client
// with projects cannot be hard-deleted; disassociate first (fail loud), matching
// the meaningful-association FK precedent (project_specs.spec_id, specs.style_source).
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('clients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('clients', 'clients_name_unique', 'UNIQUE (name)');
  pgm.addConstraint('clients', 'clients_name_nonempty', 'CHECK (length(trim(name)) > 0)');

  pgm.addColumns('projects', {
    client_id: { type: 'uuid', references: 'clients', onDelete: 'RESTRICT' },
  });
  pgm.createIndex('projects', 'client_id', { name: 'projects_client_id_idx' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('projects', 'client_id', { name: 'projects_client_id_idx' });
  pgm.dropColumns('projects', ['client_id']);
  pgm.dropTable('clients', { cascade: true });
};
```

- [ ] **Step 2: Verify up + down round-trip**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5435/specr pnpm migrate && DATABASE_URL=postgres://specr:specr@localhost:5435/specr pnpm migrate:down && DATABASE_URL=postgres://specr:specr@localhost:5435/specr pnpm migrate`
Expected: up applies 040, down rolls it back cleanly, up re-applies. No errors.

- [ ] **Step 3: Commit** `feat(db): add clients table + projects.client_id (migration 040)`

---

### Task 2: `src/db/queries/clients.ts` query module + barrel

**Files:**
- Create: `src/db/queries/clients.ts`
- Modify: `src/db/index.ts` (export the new symbols)
- Test: `src/db/queries/clients.test.ts` (unit, mocked pool), `src/db/queries/clients.integration.test.ts` (real DB)

**Interfaces:**
- Produces:
  - `interface ClientSummary { id: string; name: string; libraryId: string | null; createdAt: Date; updatedAt: Date }`
  - `interface ClientDetail extends ClientSummary { projects: readonly ProjectSummary[] }` (imports `ProjectSummary` **type-only** from `./projects.js`)
  - `interface CreateClientInput { name: string; libraryId?: string }`
  - `createClient(input, db=pool): Promise<ClientSummary>`
  - `listClients(db=pool): Promise<readonly ClientSummary[]>`
  - `getClient(id, db=pool): Promise<ClientDetail | null>`
  - `assertClientExists(clientId, db): Promise<void>` (throws `ClientNotFoundError`)
  - `class ClientNotFoundError extends DatabaseError` (→ 422 unknown client on project patch)
  - `class ClientLibraryNotFoundError extends DatabaseError` (→ 422 unknown libraryId on create)

- [ ] **Step 1: Write the module.** Key SQL: `getClient` fetches projects with their ordered `sources` via a single `LATERAL json_agg`, `LEFT JOIN clients` for `clientName`. Excludes soft-deleted projects (`deleted_at IS NULL`) to match `listProjects`. `createClient` pre-validates `libraryId` existence when provided (→ `ClientLibraryNotFoundError`); the name-unique 23505 surfaces wrapped as `DatabaseError` (cause = pg err) so `getPgCode` → 409 at the handler.

- [ ] **Step 2: Unit tests** (`clients.test.ts`, mocked pool per `projects.test.ts` pattern): createClient returns mapped summary; createClient rejects unknown libraryId with `ClientLibraryNotFoundError`; createClient wraps db failure as `DatabaseError`; listClients maps rows + `ORDER BY name, id`; getClient returns null when absent; getClient maps client + projects[].sources/clientId/clientName; assertClientExists throws `ClientNotFoundError` when missing.

- [ ] **Step 3: Integration tests** (`clients.integration.test.ts`, real DB): insert client → row present; unique name violation → pg 23505; getClient returns its associated project with sources + clientId/clientName; getClient excludes a soft-deleted project.

- [ ] **Step 4: Run** `pnpm test` (unit) and `DATABASE_URL=… NODE_ENV=test pnpm test:integration` (clients only). Expected PASS.

- [ ] **Step 5: Commit** `feat(db): clients query module (create/list/get)`

---

### Task 3: `projects.ts` — `ProjectSummary` + update path gain `clientId`

**Files:**
- Modify: `src/db/queries/projects.ts`
- Modify: `src/db/index.ts` (re-export `UpdateProjectResult` unchanged name; nothing new to export here beyond Task 2)
- Test: `src/db/queries/projects.test.ts`

**Interfaces:**
- `ProjectSummary` gains `readonly clientId: string | null; readonly clientName: string | null`.
- `createProject` returns them as `null` (a new project has no client).
- `UpdateProjectInput` gains `readonly clientId?: string | null` (absent = leave, `null` = disassociate, string = associate).
- `UpdateProjectResult` gains `readonly clientId: string | null`.
- `updateProject`: when `clientId` is a non-null string, `await assertClientExists(clientId, pool)` (import from `./clients.js`) before the UPDATE; adds `client_id = $n` to the SET list; `RETURNING … client_id`.

- [ ] **Step 1:** Add `import { assertClientExists } from './clients.js';` and `import type { … }` unchanged. Extend `ProjectSummary`, `createProject` return (`clientId: null, clientName: null`), `UpdateProjectInput`, `UpdateProjectResult`, and `updateProject` (validation + SET + RETURNING + map). Guard: validation only runs for a non-null string clientId (null clears, undefined skips).

- [ ] **Step 2: Update/extend unit tests** in `projects.test.ts`: createProject result now includes `clientId: null, clientName: null`; updateProject sets client_id when provided; updateProject with unknown clientId rejects with `ClientNotFoundError`; updateProject with `clientId: null` clears (no assert call). Mock `assertClientExists` via mocking `./clients.js`.

- [ ] **Step 3: Run** `pnpm test`. Expected PASS.

- [ ] **Step 4: Commit** `feat(db): project↔client association on update path + ProjectSummary`

---

### Task 4: REST — `src/api/clients.ts` + router + `PATCH /projects` clientId

**Files:**
- Create: `src/api/clients.ts` (`createClientHandler`, `listClientsHandler`, `getClientHandler`)
- Modify: `src/api/projects.ts` (`PatchProjectBody` + `patchProjectHandler` gain `clientId`)
- Modify: `src/api/router.ts` (wire 3 client routes; import handlers)
- Test: `src/api/clients.integration.test.ts`, extend `src/api/projects.integration.test.ts`

**Interfaces:**
- `POST /clients` body `{ name: string(min1), libraryId?: uuid }` → 201 `ApiResponse<ClientSummary>`; 400 bad body; 409 dup name; 422 unknown libraryId; 500.
- `GET /clients` → 200 `ApiResponse<ClientSummary[]>`.
- `GET /clients/{id}` → 200 `ApiResponse<ClientDetail>`; 400 bad id; 404 absent; 500.
- `PATCH /projects/{id}` body gains `clientId: z.uuid().nullable().optional()`; anyOf now includes clientId; handler threads `clientId` into the patch only when the key is present; catches `ClientNotFoundError` → 422; response `data` gains `clientId`.

- [ ] **Step 1:** Write `src/api/clients.ts` (inline Zod body, `pgErrorToHttp` for 409/422, mirrors `libraries.ts` handler style). Extend `projects.ts` PATCH. Wire routes in `router.ts`.

- [ ] **Step 2: Integration tests** (`clients.integration.test.ts`): POST creates (201) + body shape; POST duplicate name → 409; GET lists; GET /{id} returns client + projects; GET unknown id → 404; POST unknown libraryId → 422. Extend project patch test: PATCH clientId associates (200, echoes clientId) and GET /clients/{id} shows the project; PATCH clientId:null disassociates; PATCH unknown clientId → 422.

- [ ] **Step 3: Run** `pnpm test` + integration for clients/projects. Expected PASS.

- [ ] **Step 4: Commit** `feat(api): clients CRUD routes + project client association`

---

### Task 5: `openapi.yaml` + API contract gate

**Files:**
- Modify: `openapi.yaml` (paths `/clients`, `/clients/{id}`; params `ClientId`; schemas `ClientSummary`, `ClientDetail`; extend `ProjectSummary` + PATCH `/projects/{id}` response)
- Modify: `src/api/contract.integration.test.ts` (`RESPONSE_ALLOWLIST` += `post /clients`, `get /clients`, `get /clients/{}`)

- [ ] **Step 1:** Add the three paths (tags `[clients]`), `ClientId` parameter (mirrors `ProjectId`), `ClientSummary`/`ClientDetail` schemas. Extend `ProjectSummary` with `clientId` (`[string,'null']` uuid) + `clientName` (`[string,'null']`), both required. Extend PATCH `/projects/{id}` 200 `data` to include `clientId` (`[string,'null']` uuid) required, and its request body `anyOf` + `clientId` property. Add allowlist entries.

- [ ] **Step 2: Run** `DATABASE_URL=… NODE_ENV=test pnpm test:integration -- src/api/contract.integration.test.ts`. Expected: route↔spec coverage + success-JSON coverage PASS.

- [ ] **Step 3: Commit** `docs(api): document clients endpoints + project clientId (openapi)`

---

### Task 6: MCP — client tools + `update_project` clientId + contract gate

**Files:**
- Create: `src/mcp/clients-tools.ts`, `src/mcp/clients-handlers.ts`
- Modify: `src/mcp/tools.ts` (register), `src/mcp/contract-map.ts` (OP_TO_TOOL), `src/mcp/capabilities.ts` (TOOL_TIERS), `src/mcp/project-handlers.ts` (UpdateProjectShape + handleUpdateProject clientId)
- Test: `src/mcp/clients.integration.test.ts`, extend `src/mcp/project-lifecycle.integration.test.ts`

**Interfaces:**
- Tools: `list_clients` (read), `get_client` (read), `create_client` (write). Handlers mirror `library-management-handlers.ts`: parse with Zod, `ok(...)` / `toolError(...)`, never throw. `create_client` maps 23505 → `toolError('a client with that name already exists')`, `ClientLibraryNotFoundError` → `toolError(err.message)`.
- `OP_TO_TOOL`: `post /clients → create_client`, `get /clients → list_clients`, `get /clients/{} → get_client`.
- `TOOL_TIERS`: `create_client=write`, `list_clients=read`, `get_client=read`.
- `UpdateProjectShape` gains `clientId: z.uuid().nullable().optional()`; refine accepts it as a satisfying field; `handleUpdateProject` threads clientId into `UpdateProjectInput` (present-key only), catches `ClientNotFoundError` → `toolError`, echoes `clientId` in `ok(...)`.

- [ ] **Step 1:** Write tools + handlers; register in `tools.ts`; add map + tier entries; extend `project-handlers.ts`.

- [ ] **Step 2: Integration tests** (`clients.integration.test.ts`): create_client returns summary; duplicate name → isError; list_clients includes it; get_client returns projects; get_client unknown id → isError. Extend project lifecycle: update_project clientId associates + echoes; unknown clientId → isError.

- [ ] **Step 3: Run** MCP contract gate + tests: `DATABASE_URL=… NODE_ENV=test pnpm test:integration -- src/mcp/contract.integration.test.ts src/mcp/clients.integration.test.ts`. Expected: INV-1/2/2b/3 + disjointness PASS.

- [ ] **Step 4: Commit** `feat(mcp): client tools + update_project clientId`

---

### Task 7: ADR-054 + finalize

**Files:**
- Create: `docs/adr/054-first-class-clients.md`
- Commit already-present design doc `docs/superpowers/specs/2026-07-07-issue-391-clients-design.md` + this plan.

- [ ] **Step 1:** Write ADR-054 (Status / Context / Decision / Consequences) recording the four locked decisions and explicitly superseding ADR-025's firm/client deferral language.

- [ ] **Step 2: Full verification.** Run `pnpm lint`, `pnpm test`, `pnpm migrate && pnpm seed && pnpm test:integration` (with inline DATABASE_URL). Expected all green. Run `pnpm format` if prettier complains.

- [ ] **Step 3: Commit** `docs(adr): ADR-054 first-class clients` and the spec/plan docs.

---

## Self-Review Notes

- **Spec coverage:** migration (T1) ✓, DB queries + ProjectSummary (T2/T3) ✓, REST (T4) ✓, openapi (T5) ✓, MCP (T6) ✓, ADR (T7) ✓. Delete semantics live in the migration FKs; there is no `DELETE /clients` (non-goal) — the RESTRICT/SET NULL rules govern future/manual deletes only.
- **Circular-import check:** `projects.ts` → `clients.ts` is a runtime import (`assertClientExists`); `clients.ts` → `projects.ts` is **type-only** (`ProjectSummary`), erased under `verbatimModuleSyntax`. No runtime cycle.
- **Type consistency:** `ProjectSummary.clientId/clientName`, `ClientSummary.{id,name,libraryId,createdAt,updatedAt}`, `UpdateProjectResult.clientId` used identically across DB/API/MCP/openapi.
