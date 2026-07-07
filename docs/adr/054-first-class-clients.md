# ADR-054: First-class clients

## Status

Accepted (2026-07-07). Supersedes the firm/client-tier deferral in ADR-025 (#391).

## Context

The operating hierarchy for spec work is **Client → Project → Package → Issuance
(→ Revision)**, but SpecR had no `Client` entity. "Client" existed only as a *library
tier* (`libraries.tier = 'client'`, migration 016 / #92) and could be *approximated*
by inspecting each project's client-tier source libraries via `ProjectSummary.sources`.

ADR-025 (#209) noted that "firm/client scope tiers are data and migrations" and deferred
them as YAGNI — the scoped-profile chain attached at project scope "for now, with
firm/client as future links." That future is now: a hyperscale-datacenter owner (or any
client) runs many campuses/projects, and grouping, defaults, and chain-of-custody all
want a real edge from a project to the organization that owns it. Approximating the client
by library membership conflates *content provenance* (which masters a project draws from)
with *organizational ownership* (whose projects these are) — two different questions.

## Decision

Introduce a first-class `clients` table (migration 040) and a nullable
`projects.client_id`, exposed over REST (`POST/GET /clients`, `GET /clients/{id}`,
`PATCH /projects/{id}` accepting `clientId`) and MCP (`list_clients`/`get_client` read,
`create_client` write; association rides `update_project`). Four decisions were locked in
the brainstorm:

1. **Link, not merge.** `clients` is a new *organizational* entity; client-tier libraries
   remain the *content* substrate. `clients.library_id` is an **optional pointer** to the
   client's master library — the two concepts are never merged. A UI can group projects by
   client via the real edge instead of guessing from source libraries.

2. **ON DELETE semantics follow the house pattern** (containment = CASCADE, optional
   cross-reference = SET NULL, meaningful association = RESTRICT):
   - `projects.client_id → clients(id)` is **ON DELETE RESTRICT** — a client with projects
     cannot be hard-deleted; disassociate first, fail loud (matches `project_specs.spec_id`
     and the ADR-defended `specs.style_source` RESTRICT). There is deliberately **no
     `DELETE /clients` endpoint** — the FK governs any future/manual delete.
   - `clients.library_id → libraries(id)` is **ON DELETE SET NULL** — the library link is an
     optional cross-reference, not ownership; a client stays valid without its library
     (matches `spec_references.target_spec_id`).

3. **Firm forward-compat is prose only.** No `firms` table/tier stub is created (YAGNI).
   When a firm hop is eventually needed, it inserts at the top of the recurring
   scoped-profile resolution chain — **firm → client → project → package → revision** — as
   data and a migration, exactly as ADR-025 anticipated. Clients are the first of those
   links to become real.

4. **Clients are organizations, not actors.** #381's `users` table is a *different* concern
   (identity/authorship); this table is organizational grouping. #43 multi-tenancy will
   later scope both. An unknown client on a project association is validated in the query
   layer (`assertClientExists` → `ClientNotFoundError`) and surfaces as a clean **422**
   (REST) / `isError` (MCP), never a raw FK error.

## Consequences

- `ProjectSummary` gains `clientId` + `clientName` (denormalized via LEFT JOIN for list
  ergonomics); `createProject` returns them as `null` (a new project has no client).
  `GET /clients/{id}` returns the client with its **active** projects as full
  `ProjectSummary` rows (soft-deleted projects excluded, matching `GET /projects`).
- The REST↔MCP contract stays in lockstep: three new ops map to three new tools
  (`OP_TO_TOOL`), each tiered in `capabilities.ts`; `create_client` is `write`, the reads
  are `read`, so a read-only agent can browse clients but not create them.
- **Migration reversibility** is a clean structural revert (drop index + column, drop
  table); no seed rows are added, so nothing to unwind on `down`.
- **Deferred (follow-ups, not this slice):** a `firms` tier; auth/tenancy (#43); and
  migrating the existing scoped profiles (nomenclature #209, header/footer #208, style
  #125) onto a client scope — those attach once the entity exists. This ADR creates the
  entity; it does not rewire the profile chain.
