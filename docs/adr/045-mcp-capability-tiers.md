# ADR-045: MCP capability tiers & permission scoping

## Status

Accepted (2026-07-02).

## Context

The MCP surface is moving from read-only tools to write tools (starting with
`create_project`, ADR-044) and, in later waves, destructive ones
(`delete_project`, `delete_spec`, library/template deletes). An MCP server is a
single trust boundary: whatever tools it registers, a connected agent can call.
Without a control, exposing write and delete tools to an autonomous agent means a
prompt-injected or confused agent could delete a client's projects or libraries.

MCP already defines per-tool `annotations` (`readOnlyHint`, `destructiveHint`)
that hint a client's UI, but those are advisory hints to the *client* — they do
not stop the server from answering the call. We need server-side gating: the
process decides which classes of tool it will even register, so a gated tool is
not listable and not callable, full stop.

Token-scoped, per-caller tiers (a read-only agent token vs. an admin token) are
the eventual goal but depend on the auth work tracked in #43, which does not exist
yet. We need a control that ships now and composes with per-token scopes later.

## Decision

Every MCP tool declares one of three **capability tiers**, and the process gates
which tiers it exposes:

- **`read`** — no state change (queries, reports, reference reads). Stamped
  `readOnlyHint: true`.
- **`write`** — persists non-destructive state (create/update; `parse_document`,
  `load_files`, `create_project`, editability overrides). Stamped
  `readOnlyHint: false, destructiveHint: false`.
- **`destructive`** — deletes/withdraws that lose data
  (`delete_project`, `delete_spec`, …). Stamped `destructiveHint: true`.

Implementation:

1. **`src/mcp/capabilities.ts`** is the single source of truth: `TOOL_TIERS`
   (tool name → tier), plus pure helpers `parseAllowedTiers`, `tierAnnotations`,
   `isToolTier`, `TOOL_TIER_VALUES`. No SDK imports (keeps it testable and
   dependency-light).
2. **`src/mcp/tool-registry.ts`** — a gating registrar routes every tool
   registration. It looks up the tool's tier and:
   - **throws at registration** if the tool has no declared tier (this is what
     ADR-044's INV-3 relies on — an untiered tool cannot ship), and
   - **records but does not register** a tool whose tier is not in the allowed
     set (gated: absent from `tools/list`, not callable), otherwise registers it
     on the server with the tier's annotations merged in.
3. **`MCP_ALLOWED_TIERS`** (env, `src/lib/env.ts`) selects the exposed tiers,
   validated at boot. **Default `read,write`** — `destructive` is gated off, so an
   agent cannot delete projects/clients/libraries unless an operator explicitly
   opts in.

Rejected / deferred alternatives:

- **Elicitation / per-call confirmation** for destructive tools (ask the human to
  confirm mid-call) — deferred. It is a client-cooperative UX affordance, not a
  server-side guarantee; a non-cooperating client would bypass it. Server-side
  tier gating is the hard control; elicitation can be layered on later for tools
  that *are* exposed.
- **Per-token / per-caller tier scoping** — deferred to #43 (auth). The env-level
  gate is process-wide today; token scopes will narrow it per caller once auth
  lands. The AUTH HOOK comment in `server.ts` marks where that composes in.

## Consequences

- **Destructive actions are off by default** — safe posture for an autonomous
  agent out of the box; an operator opts into deletes via
  `MCP_ALLOWED_TIERS=read,write,destructive`.
- **Every tool must declare a tier** or it cannot register (INV-3, ADR-044) — no
  untiered tool can silently ship. `TOOL_TIERS` is the one place to look for
  "what can this tool do".
- **Clients get correct MCP hints** — `readOnlyHint`/`destructiveHint` are stamped
  from the tier, so cooperating clients can badge/confirm accordingly.
- **Config, not code, sets exposure** — flipping tiers needs no redeploy of tool
  code, just an env change (fail-fast validated at boot).
- The gate is **process-wide** until #43; that is a deliberate, tracked limitation,
  not an oversight.

## Related

- [ADR-044](044-mcp-contract-testing.md) — the contract test whose INV-3 requires
  every tool to be tiered.
- [ADR-010](010-mcp-server.md) — the MCP server this scopes.
- Issue #43 — token-scoped auth that will make tiers per-caller.
