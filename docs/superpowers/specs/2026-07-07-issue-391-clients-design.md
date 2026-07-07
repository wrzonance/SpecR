# Design: first-class clients — `clients` table + `projects.client_id` (#391)

**Date:** 2026-07-07
**Issue:** [#391](https://github.com/wrzonance/SpecR/issues/391)
**Status:** Approved (brainstormed with thewrz; ON DELETE semantics settled)
**Lifts:** the #209/ADR-025 firm/client-table deferral

## Why

The operating hierarchy is Client → Project → Package → Issuance (→ Revision), but SpecR has no
Client entity. "Client" exists only as a library tier (`libraries.tier='client'`, migration 016)
and indirectly via `ProjectSummary.sources`. A client (e.g. a hyperscale datacenter owner) runs
many campuses/projects; grouping, defaults, and custody all want the real edge.

## Decisions (locked in this brainstorm — ADR-054 records them)

1. **Link, not merge.** `clients` is a new organizational entity; client-tier libraries remain the
   content substrate. `clients.library_id` is an optional pointer to the client's master library —
   the two concepts are never merged.
2. **ON DELETE semantics** (follows the established house pattern — containment = CASCADE,
   optional cross-reference = SET NULL, meaningful association = RESTRICT):
   - `projects.client_id → clients(id)` **ON DELETE RESTRICT** — a client with projects cannot be
     hard-deleted; disassociate first, fail loud. Matches `project_specs.spec_id` and the
     ADR-defended `specs.style_source` RESTRICT.
   - `clients.library_id → libraries(id)` **ON DELETE SET NULL** — the library link is an optional
     cross-reference, not ownership; a client stays valid without its library. Matches
     `spec_references.target_spec_id`.
3. **Firm forward-compat is prose only.** No `firms` table stub. ADR-054 notes where the firm hop
   inserts into the scoped-profile resolution chain (firm → client → project → package → revision)
   when it is eventually needed. YAGNI.
4. **Clients are organizations, not actors.** #381's `users` table is a different concern; #43
   multi-tenancy will scope both later.

## Migration `040_create_clients.ts` (reversible)

- `clients`: `id uuid PK DEFAULT gen_random_uuid()`, `name text NOT NULL UNIQUE`,
  `library_id uuid NULL REFERENCES libraries(id) ON DELETE SET NULL`,
  `created_at`/`updated_at` timestamps per house column conventions.
- `projects.client_id uuid NULL REFERENCES clients(id) ON DELETE RESTRICT` + index on `client_id`.
- Down: drop the column/index, drop the table.

## DB layer

- New `src/db/queries/clients.ts`: `createClient`, `listClients`, `getClient` (joins its
  projects as `ProjectSummary[]`).
- `src/db/queries/projects.ts`: the existing update path gains `clientId` handling (set and
  explicit-null clear); `ProjectSummary` gains `clientId` and `clientName` via LEFT JOIN.

## REST (`src/api/clients.ts` router)

- `POST /clients` → 201 `ApiResponse<ClientSummary>`; unique-name violation → 409.
- `GET /clients` → `ApiResponse<ClientSummary[]>`.
- `GET /clients/{id}` → client + `projects: ProjectSummary[]`; unknown id → 404.
- `PATCH /projects/{id}` accepts `clientId?: string | null` — explicit `null` disassociates.
  Zod: `z.uuid().nullable().optional()` (`exactOptionalPropertyTypes`-safe). Unknown client →
  422 per the FK-validation convention.
- `openapi.yaml` updated in the same PR (paths, operationIds, `ClientSummary` schema,
  `ProjectSummary`/patch-body changes). Additive/back-compat.

## MCP

- Tools: `list_clients` / `get_client` (tier `read`), `create_client` (tier `write`).
- `src/mcp/contract-map.ts` + `src/mcp/capabilities.ts` entries; project association rides the
  existing update-project tool, whose input schema gains `clientId`.

## ADR-054

`docs/adr/054-first-class-clients.md` — Status / Context / Decision / Consequences covering the
four locked decisions above and explicitly superseding the deferral language in ADR-025.

## Testing

- Unit: query shape + route validation (name required, uuid formats, null-vs-absent clientId).
- Integration: create/list/get; associate + disassociate; 409 duplicate name; 404 unknown client
  id; 422 unknown client on patch; migration up/down round-trip.
- Both contract gates green: `src/api/contract.integration.test.ts`,
  `src/mcp/contract.integration.test.ts`.

## Non-goals

No `DELETE /clients` endpoint (ON DELETE semantics govern manual/future deletes only); no `firms`
table/tier; no auth/tenancy; no migration of existing scoped profiles (nomenclature,
header/footer, style) onto the client scope — follow-ups once the entity exists.
