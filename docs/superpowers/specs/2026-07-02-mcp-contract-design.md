# MCP Contract — full REST↔MCP parity, verified by tests, with permission tiers

**Status:** DRAFT — brainstorm design, pending author review.
**Date:** 2026-07-02
**Branch:** `feat/mcp-contract`
**Related issues:** #44 (MCP write tools), #43 (auth + multi-tenant), #99 (keynote export MCP tool), #331 (shared ToolResult refactor)
**Related ADRs:** ADR-026 (OpenAPI contract testing — the sibling this mirrors), ADR-010 (MCP server), ADR-002 (API-first headless)

> ⚠️ **Away-from-keyboard defaults.** The author was away when the pivotal fork was
> asked. This doc proceeds on the **recommended** answer to each open decision and
> flags every such choice with **`[DEFAULT — confirm]`**. Nothing here is
> implemented yet; this is the design artifact for review before `writing-plans`.

---

## 1. Problem

A user can do ~64 things through the REST API / `openapi.yaml` (project/spec/paragraph/
package/library/template CRUD, merge, locks, numbering-profile & style-source assignment,
editability, revision nomenclature, coordination, submittal register…). The MCP server
(`src/mcp/`) exposes only **~22 tools, almost all read + parse/generate/load** — there are
essentially **no write tools**. So an AI agent (in `examples/web_ui_demo`'s chat, or any MCP
client) can *read* SpecR but cannot *do* most of what a human can.

Worse, the two surfaces drift silently: adding a REST route today wires up nothing on the MCP
side, and nothing fails. We want the same guarantee `openapi.yaml` already enjoys — **the agent
surface cannot silently fall out of sync with the API surface** — plus a way to keep destructive
"admin" actions (deleting projects, clients, libraries) off-limits to the agent by default.

### What already works (do not rebuild)

- **Chat ← MCP is already automatic.** `examples/web_ui_demo/server.mjs → listOpenAiTools()`
  calls MCP `tools/list` at runtime and maps every tool's `inputSchema` straight into OpenAI
  function-calling. **Any tool registered in MCP appears in the chat with zero per-tool wiring.**
  The chat half of "first-class agent integration" is structural, not per-feature.
- **The service layer is shared.** ADR-010: MCP is "a second interface over the same service
  layer used by REST — no duplication of business logic." New write tools call the same
  `src/db` / `src/parser` / `src/generator` / `src/merge` functions the REST routes call —
  **never** REST-over-HTTP from inside the process.

So the whole effort is really **one seam: MCP ← REST/OpenAPI.**

## 2. Goals & non-goals

**Goals**
1. Every *user-facing* OpenAPI operation is reachable via an MCP tool, or is **explicitly and
   reviewably** exempted (the ADR-026 allowlist pattern, inverted for MCP).
2. A **CI contract test** makes drift a red build — a new REST op with no MCP tool (and no
   exemption) fails, and an orphan MCP tool that maps to nothing fails.
3. A **capability-tier** model (`read` / `write` / `destructive`) on every tool, with
   **server-side gating** so destructive/admin actions are not exposed to the agent by default.
4. The demo chat gains real write ability (create/edit) without gaining the ability to delete
   projects/clients/libraries.

**Non-goals**
- Generating tools from `openapi.yaml` (rejected — see §4, mirrors ADR-026's rejection of
  spec-from-code).
- Full auth/multi-tenant (#43). We build the **gating seam** and a config default now; token-scoped
  tiers land with #43. Same staging ADR-010 used for its auth hook point.
- Streaming tool progress, MCP prompts, or new resources beyond what parity needs.
- Reworking the demo chat UI. It already consumes `tools/list`; more tools "just appear."

## 3. The three components

### 3.1 The MCP contract (the parity gate) — sibling of ADR-026

A new integration test, `src/mcp/contract.integration.test.ts`, enforces three invariants against
two manifests, reusing the existing `src/test-utils/contract/` helpers (`loadSpec`,
`specOperationManifest`) and a new `mcpToolManifest()` that boots an `McpServer`, calls
`tools/list`, and returns tool names + tiers.

**A single hand-authored mapping is the source of truth** (`src/mcp/contract-map.ts`):

```ts
// One entry per relationship. OperationId format matches the OpenAPI manifest: "post /projects".
export const OP_TO_TOOL: ReadonlyMap<OperationId, string> = new Map([
  ['post /projects',                 'create_project'],
  ['patch /projects/{}',             'rename_project'],
  ['post /specs/{}/paragraphs',      'add_paragraph'],       // #44
  ['patch /specs/{}/paragraphs/{}',  'update_paragraph'],    // #44
  // …
]);

// User-facing OPs intentionally NOT exposed as tools — each with a reason. Burned down over time.
export const MCP_UNEXPOSED: ReadonlyMap<OperationId, string> = new Map([
  ['get /health',        'liveness probe — not an agent action'],
  ['get /openapi.yaml',  'contract artifact — not an agent action'],
  // binary/asset/docs routes, etc.
]);

// Tools with NO single REST equivalent (MCP-native). Allowed to map to nothing.
export const MCP_NATIVE: ReadonlySet<string> = new Set([
  'search_library',   // no /search route; MCP-native affordance
  'load_files',       // bulk CLI/loader affordance
]);
```

**Invariants the test pins (module-boundary, not internals):**
- **INV-1 (coverage):** every user-facing OpenAPI op is in `OP_TO_TOOL` **or** `MCP_UNEXPOSED`.
  A new route with neither → RED. *(Direct analog of ADR-026's route↔spec coverage.)*
- **INV-2 (no orphans):** every registered MCP tool is a value in `OP_TO_TOOL` **or** in
  `MCP_NATIVE`. A tool that maps to nothing → RED.
- **INV-3 (every tool is tiered):** every registered tool has a declared tier (§3.2). Untiered → RED.
- **INV-4 (schema alignment, pragmatic):** for each mapped **write** tool, the tool's Zod
  `inputSchema` accepts the OpenAPI op's **required** request fields (shape check, not deep
  equality — the same pragmatic altitude ADR-026 chose for response coverage).

`MCP_UNEXPOSED` is the burn-down list, exactly like ADR-026's `RESPONSE_ALLOWLIST`.

### 3.2 Capability tiers & permission scoping

A registry, `src/mcp/capabilities.ts`, declares a tier per tool and is the source of truth INV-3
checks:

```ts
export type ToolTier = 'read' | 'write' | 'destructive';
export const TOOL_TIERS: ReadonlyMap<string, ToolTier> = new Map([
  ['get_spec', 'read'], ['search_library', 'read'],
  ['create_project', 'write'], ['add_paragraph', 'write'],
  ['delete_project', 'destructive'], ['delete_library_client', 'destructive'],
  // …
]);
```

- Tiers map to **MCP tool annotations** (the industry-standard signal): `read` → `readOnlyHint:
  true`; `destructive` → `destructiveHint: true`; `idempotentHint` where applicable. Clients that
  understand annotations get the hint for free.
- **Server-side gating.** `registerTools(server, { allowedTiers })` registers only tools whose
  tier ∈ `allowedTiers`. A tool that isn't registered is neither listed nor callable — gating is by
  *absence*, the safe default (can't call what isn't there).
- **Default posture `[DEFAULT — confirm]`:** `allowedTiers = {read, write}`. `destructive` is
  **off by default**. Source of the set, in precedence order:
  1. **Now:** env/config `MCP_ALLOWED_TIERS` (default `read,write`). One knob, matches
     `src/lib/env.ts` fail-fast Zod validation.
  2. **With #43:** bearer-token scopes → tiers, per session. This is the same hook point ADR-010
     already reserves for MCP auth; we wire the seam, #43 fills it.
- The **demo chat** runs with the default `{read, write}` → the assistant can create and edit, but
  **cannot delete a project/client/library**. Humans still do destructive ops in the UI.
- **Deferred option (not v1):** instead of hiding destructive tools, expose them but require MCP
  **elicitation** (human-in-the-loop confirm). Simpler v1 = not granted ⇒ not listed. Noted for a
  future ADR.

### 3.3 Write-tool build-out (closes the real gap — #44 and siblings)

Add the missing tools as thin wrappers over the shared service layer, hand-authored (LLM-tuned
descriptions), Zod schema adapted from the REST schema, tier declared, entry added to `OP_TO_TOOL`.
Sequenced so `MCP_UNEXPOSED` burns down in reviewable, ≤~500-LOC PRs:

| Wave | Domain | Representative tools | Tier |
|------|--------|----------------------|------|
| 1 | Contract scaffold | test + `contract-map.ts` + `capabilities.ts` + gating, **no new tools** | — |
| 2 | Projects/packages | `create_project`, `rename_project`, `create_package`, `assign_specs_to_package` | write / destructive(delete) |
| 3 | Paragraphs (#44) | `add_paragraph`, `update_paragraph`, `remove_paragraph` | write |
| 4 | Spec lifecycle | `finalize_spec`, `reopen_spec`, `restore_spec`, `delete_spec` | write / destructive |
| 5 | Merge/diff | `apply_merge`, (diff read already exists) | write |
| 6 | Assignment | `assign_numbering_profile`, `assign_style_source`, locks | write |
| 7 | Config CRUD | templates, conventions, required-sections, revision-nomenclature | write / destructive |

Each wave: burns down its `MCP_UNEXPOSED` entries, keeps the contract test green, keeps `main`
releasable. Reads may be tools or resources; **default `[DEFAULT — confirm]`: reads become tools**
(the chat bridge consumes only `tools/list`), keeping the 3 existing resources as-is.

## 4. Alternatives considered

- **Generate MCP tools from `openapi.yaml`** (Speakeasy / FastMCP `from_openapi` / `openapi-mcp-
  generator`, etc.). Literal zero-gap auto-sync, but emits one terse machine-named tool per op and
  **flattens the hand-tuned descriptions** that make the current tools good for LLMs. Directly
  contradicts ADR-026's reasoning ("would lose the readable, reviewable hand-authored spec for a
  marginal gain"). **Rejected** — the contract gate gets the "can't drift" guarantee without the
  ergonomic tax.
- **Hybrid registry** (auto-generate pure-CRUD tools, hand-override the rest). Most flexible, most
  machinery, two codepaths to maintain. Deferred; revisit only if the hand-authored surface grows
  unwieldy.
- **Lint/coverage only (no schema check).** Weaker than INV-4; cheap to add later, not a substitute.

## 5. Open decisions (author, please confirm)

- **A. Sync mechanism** = CI parity gate (hand-authored). `[DEFAULT — confirm]`
- **B. Parity scope** = user-facing ops; exempt only health/docs/asset/contract routes. Job-polling
  endpoints (`get /parse/jobs/{}`, import jobs) **become tools** so an agent can poll its own job.
  `[DEFAULT — confirm]`
- **C. Permission default** = expose `{read, write}`, gate `destructive` off; destructive =
  every delete/withdraw of project/client/library/spec/package. `[DEFAULT — confirm]`
- **D. Reads as tools vs resources** = tools (uniform with the chat bridge), keep existing 3
  resources. `[DEFAULT — confirm]`
- **E. Ordering vs #43** = ship contract + tiers + config gating now; token-scoped tiers when #43
  lands. `[DEFAULT — confirm]`

## 6. Testing (the invariants ARE the tests)

- INV-1…4 in `src/mcp/contract.integration.test.ts` (§3.1).
- INV-5: with `MCP_ALLOWED_TIERS=read,write`, `tools/list` contains **no** `destructive` tool and a
  `tools/call` to one returns an MCP error — gating actually works.
- Per new write tool: one integration test round-tripping through the shared service layer + DB.
- Regression tests named by symptom, per CLAUDE.md.

## 7. Consequences / follow-ups

- **New ADR-044** "MCP contract — hand-authored tool parity, verified by tests" (sibling to 026).
- **New ADR-045** "MCP capability tiers & permission scoping."
- `openapi.yaml` stays the single source of truth for the *operation set*; the MCP contract binds to
  it. One place to add an op; **two** gates (REST response contract + MCP parity) enforce full wiring.
- CI integration sequence gains the MCP contract test (after `migrate → seed`, with the rest).
- CLAUDE.md gains an "MCP contract" note beside the existing openapi-contract paragraph.
