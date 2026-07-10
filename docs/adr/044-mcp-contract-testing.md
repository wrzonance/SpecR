# ADR-044: MCP contract — hand-authored tool parity, verified by tests

## Status

Accepted (2026-07-02).

## Context

`openapi.yaml` is protected from silent drift by a CI contract gate (ADR-026):
every Express route is documented and every documented operation is routed, and
covered responses are schema-validated. The MCP tool surface (`src/mcp/`, ADR-010)
had no such guarantee. It is a second interface over the same service layer, but
nothing tied it back to the REST operations it mirrors. A new REST endpoint could
ship with no corresponding MCP tool — and no signal that the agent surface had
fallen behind. Conversely, a registered tool could drift into referencing an
operation that no longer exists. The MCP surface could rot exactly the way
`openapi.yaml` could before ADR-026 locked it down.

Options considered:

- **(a) Generate MCP tools from `openapi.yaml`.** Rejected for the same reason
  ADR-026 rejected generating the spec from code: tool descriptions and input
  shapes are hand-tuned affordances for an agent (a good `create_project`
  description tells the agent to discover library UUIDs first — machinery a
  generator cannot infer). Generation would flatten that into mechanical
  one-tool-per-route output and lose the readable, reviewable hand-authored
  surface, for a marginal coverage gain over (b).
- **(b) Contract-test the hand-authored tools** against the authoritative spec.
  Chosen — the mirror of ADR-026's route↔spec coverage.
- **(c) Lint/name-coverage only.** Too weak; would not catch an op with no tool.

## Decision

Keep the MCP tools hand-authored and **enforce their parity with the API in CI**,
mirroring ADR-026:

1. **`src/mcp/contract-map.ts`** is the hand-authored parity source of truth:
   - `OP_TO_TOOL` — every user-facing OpenAPI operation → the MCP tool that
     performs it.
   - `MCP_UNEXPOSED` — operations intentionally *not* exposed as a tool, each with
     a reason. This is a **burn-down list**: `pending — wave N` entries become
     `OP_TO_TOOL` entries as each write-tool wave lands; permanent entries (async
     job polling, batch DOCX egress, reference reads an MCP-native tool already
     serves) stay with a permanent reason.
   - `MCP_NATIVE` — tools with no single REST equivalent (allowed to map to
     nothing).

2. **`src/mcp/contract.integration.test.ts`** enforces the invariants (mirror of
   `src/api/contract.integration.test.ts`):
   - **INV-1** — every user-facing REST op maps to a tool (`OP_TO_TOOL`) or is
     explicitly unexposed (`MCP_UNEXPOSED`); a small `EXEMPT` set covers true
     non-actions (health, `/openapi.yaml`, `/docs`, the `/mcp` transport plumbing).
   - **INV-2** — every registered tool maps to a real op or is `MCP_NATIVE` (no
     orphans).
   - **INV-3** — every registered tool has a declared capability tier (the
     registrar throws at registration time if not — see ADR-045).
   - Plus a disjointness/realness check: `OP_TO_TOOL` and `MCP_UNEXPOSED` are
     disjoint and every key is a real operation in `openapi.yaml`.
   - Write tools additionally pin **INV-4** (the tool's input schema covers the
     OpenAPI required request fields) in their own integration test — see
     `create-project.integration.test.ts`.
   - **INV-5** (#403) — tool **response** shapes. For each driven read tool the
     gate invokes the handler against seeded data, wraps its bare payload as the
     REST envelope (`{ success: true, data }` — `SuccessResponse` is just
     `{ success: true }`), and **reuses the REST `assertResponse` validator** to
     check it against the mapped op's OpenAPI response schema (no second
     validator). Because each driven read returns the REST route's own `data`,
     validation is correct by construction and auto-tracks REST drift. Coverage
     is a burn-down mirroring `MCP_UNEXPOSED`: the seed-only list reads are
     driven live; read tools that mirror but need a fixture graph sit in
     `INV5_READ_PENDING` (graduating in as fixtures land); tools whose output
     legitimately reshapes (e.g. `get_spec`, which nests `{ tree, references }`
     plus MCP `_meta` anchors) sit in `INV5_SHAPE_EXEMPT` with a reason. A
     completeness invariant asserts every read-mapped (GET) tool is in exactly
     one bucket, so no read tool drifts silently. Scoped to reads: write/
     destructive tools return mutation results whose request contract INV-4
     already pins.

Generation-from-spec is rejected (option a). The operation-id format
(`"method /path"` with every path param collapsed to `{}`) matches
`specOperationManifest`, so the map keys are checked against the live spec.

## Consequences

- **Adding a REST route without a tool (or a reasoned exemption) fails CI** — the
  same "cannot silently drift" guarantee `openapi.yaml` has.
- **The agent surface burns down to full parity.** `MCP_UNEXPOSED` starts large
  (most mutations are not yet tools) and shrinks wave by wave; when the roadmap
  lands it holds only permanent, reasoned exemptions.
- **New tools must be classified.** A registered tool with no `OP_TO_TOOL` /
  `MCP_NATIVE` home fails INV-2 — no orphan tools.
- **The test is an integration test** because importing `registerTools`
  transitively imports `../db/index.js` → `../lib/env.js`, which needs
  `DATABASE_URL` present at import (it never queries; no SQL runs).
- Enforcement covers **operation ↔ tool coverage** and, via **INV-5** (#403),
  driven read tools' **response** shapes against the mapped op's OpenAPI schema
  (INV-4 covers write-tool request fields). INV-5's read coverage is a burn-down
  (`INV5_READ_PENDING`) with reasoned reshape exemptions (`INV5_SHAPE_EXEMPT`)
  and a completeness invariant, so what is not yet driven is explicit, not
  silent — the same posture ADR-026 takes with its response allowlist.

## Related

- [ADR-026](026-openapi-contract-testing.md) — the OpenAPI contract gate this mirrors.
- [ADR-010](010-mcp-server.md) — the MCP server as a thin layer over the service
  layer.
- [ADR-045](045-mcp-capability-tiers.md) — the read/write/destructive tiers that
  INV-3 enforces.
