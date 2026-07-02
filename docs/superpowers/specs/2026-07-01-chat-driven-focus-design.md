# Chat-driven "focus the current tab" channel — Design

**Status:** Approved (2026-07-01)
**Scope:** `examples/web_ui_demo` chat sidebar + SpecR MCP tool output contract
**Related:** PR #324 (demo umbrella, `feat/webgui-landed-features`), ADR-041 (audit locate/pulse machinery)

## Problem

The demo chat sidebar answers spec questions by calling SpecR's MCP tools
(OpenAI tool-calling loop in `server.mjs`, bridged to `POST /mcp`). When the
agent answers a locate-style question — *"which spec references firestopping"* —
the answer is text only. The user must then hunt for that section by hand in the
Project Spec Map or Report tab.

The structured data needed to jump there **already exists**: every MCP tool
returns `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`, and the
result carries `specId` / `section` / `paragraphId`. But the chat bridge feeds
that text to OpenAI and returns only `{ reply, toolCalls: [{name, ok}], model }`
to the browser — the anchors are **dropped at the bridge**. The two live views
already know how to highlight (`navigateToSection` for the Map, `audit.showSection`
for the Report / ADR-041 pulse machinery). What's missing is a signal telling the
browser *which* section the answer is about.

## Goal

When a chat answer resolves to one or more sections, the demo highlights them in
the **currently-active** tab (Map or Report), scrolling to the first. When the
active tab can't show them, a non-blocking toast points the user to the Map.
This is delivered as a genuine, reusable **MCP output-contract extension** — not
prose parsing or a UI-coupled tool.

## Non-goals

- No auto-switching of tabs. "Refresh the current tab" is literal; the toast is
  the fallback, never a forced navigation.
- No new UI-only MCP tool (rejected alternative — see Decisions).
- No model-narrowed focus subset. Anchors come from the answering tool's result,
  not from parsing which sections the final prose named (accepted trade-off).
- Cross-machine chat-history persistence is a **separate** spec, brainstormed next.

## Decisions (alternatives considered)

1. **Structured MCP output (chosen).** Give the locate-oriented tools a real MCP
   `outputSchema` and return `structuredContent` carrying stable anchors. The
   bridge forwards them. Protocol-grade, reusable by any MCP client, additive.
2. *Dedicated `highlight` MCP tool (rejected).* Most precise (model narrows to
   its exact answer) but pollutes a general-purpose server with a side-effect-free
   UI-coupled tool that is noise for non-demo clients (Claude Desktop, etc.).
3. *Prompt-only JSON block (rejected).* Zero contract change but contradicts the
   "extend the MCP API/contract" requirement, relies on the model faithfully
   echoing IDs into prose (fragile), and isn't reusable.

**Tab-mismatch behavior (chosen):** current tab + toast fallback — highlight in
the active tab when it can; otherwise a non-blocking toast. Honors "current tab",
never yanks the user, never silently no-ops.

**Multiple targets (chosen):** highlight all, scroll to the first.

## Architecture

Three layers, split across two branches:

### A. MCP contract (backend — branch `feat/mcp-focus-anchors` from `origin/main`)

Enrich **four** locate-oriented tools whose handlers already hold `section`/`specId`
data (`src/mcp/handlers.ts` + `src/mcp/coordination-handler.ts`):

| Tool | Anchors derived from result |
|---|---|
| `search_library` | `{section, specId, paragraphId}` per hit |
| `get_references` | queried `section` + `{section, specId?, paragraphId?}` per outbound/inbound ref |
| `coordination_report` | `{section, specId?, paragraphId?}` per finding — `dangling_ref` is paragraph-precise; reference findings anchor at source section on `main` (built from `ClassifiedRef`, no per-paragraph locator), paragraph-precise on the demo branch where #328 is present |
| `get_spec` | `{section, specId}` for the spec |

**`get_paragraph` is deliberately excluded** — its result (`ParagraphWithAncestors`)
carries only `paragraphId`, no `section`/`specId`, so it cannot drive either view
without an extra join. Deferred, not needed for v1.

- **Carrier = the result's `_meta` field**, not `outputSchema`/`structuredContent`.
  `get_spec` returns an entire spec tree, so a full output schema would be
  disproportionate and brittle; `_meta` is MCP's sanctioned channel for
  implementation metadata and leaves the existing text `content` byte-for-byte
  unchanged, so no existing consumer breaks. Anchors live at
  `result._meta['specr/anchors']`.
- A new pure module `src/mcp/anchors.ts` owns the `McpAnchor` type
  (`{ section: string; specId?: string; paragraphId?: string }` — `section`
  required, id fields omitted when absent per `exactOptionalPropertyTypes`), the
  per-tool derivation helpers, and `anchorsMeta(anchors)`. It imports only the
  real result types from the `../db/index.js` barrel — no boundary violation,
  fully unit-testable with plain objects.
- Each of the four handlers appends `_meta` only when anchors are non-empty; the
  `ToolOk` type gains `readonly _meta?: Record<string, unknown>`.
- **No DB or REST change** — anchors are a projection of data the handlers
  already have. The `_meta` anchor contract is documented in `ARCHITECTURE.md`
  (MCP section), not in the model-facing tool descriptions.
- **openapi.yaml:** `POST /mcp` is an opaque JSON-RPC passthrough (not schema'd
  against per-tool output), so the expected outcome is **no openapi change** —
  verified by grep in the backend task. If it *does* constrain tool results,
  openapi is updated in the same commit (house rule: openapi is authoritative).

### B. Chat bridge (demo — branch `feat/webgui-landed-features`)

`examples/web_ui_demo/server.mjs`:

- `execToolCall` already receives the full MCP `tools/call` result. It reads
  `result._meta?.['specr/anchors']` (an array) when present and returns it
  alongside `{ text, ok }`.
- `runChat` keeps the anchors from the **last successful enriched tool call** of
  the turn, deduped by `${section}|${specId ?? ''}|${paragraphId ?? ''}` and
  capped at 50 entries.
- The `/chat` response gains `focus: { anchors: Anchor[] }` (empty array when the
  turn surfaced none). Existing fields (`reply`, `toolCalls`, `model`) unchanged.

### C. Front-end (demo — branch `feat/webgui-landed-features`)

- `examples/web_ui_demo/js/chat.js`: on a `/chat` reply, if `data.focus.anchors`
  is non-empty, call `applyFocus(anchors)`.
- `examples/web_ui_demo/js/app.js`: new exported `applyFocus(anchors)`:
  - **Map active** (`currentView === 'map'`) → for each anchor, pulse the matching
    section node via the existing tree pulse; scroll the first into view.
  - **Report active** (`currentView === 'report'` — driven by the `audit.js`
    module) → `audit.showSection(anchor.section)` for each; scroll first.
  - **Neither / no matching node** (`toc`, `settings`, `library`, `numbering`,
    `submittal`, or no rendered node) → non-blocking toast via the existing
    `toast()`: `"{n} section(s) found — open Project Spec Map to view."`
  - `applyFocus` reads the existing `currentView` state (default `'map'`); it
    never switches views.

`navigateToSection` today targets a single section and switches to Map. For
`applyFocus` we need "pulse in the current view, all targets, no forced switch."
Extract a small `pulseSection(section, { scroll })` used by both, so the existing
single-target behavior is preserved and `applyFocus` composes it.

## Data flow

```
user asks in chat
  → server.mjs runChat → OpenAI tool loop → MCP tools/call (e.g. search_library)
      ← tool returns text (unchanged) + _meta['specr/anchors']
  → execToolCall captures anchors; runChat keeps last enriched call's anchors
  → /chat responds { reply, toolCalls, model, focus: { anchors } }
  → chat.js → applyFocus(anchors)
      → currentView === 'map'    → pulseSection(each), scroll first
      → currentView === 'report' → audit.showSection(each), scroll first
      → else / no match          → toast("N sections found — open Project Spec Map")
```

## Error handling

- MCP tools **never throw** (house rule): anchor derivation runs only on the
  success path over data already in hand; `_meta` is simply omitted when there
  are no anchors. The bridge treats missing/invalid `_meta['specr/anchors']` as
  an empty focus.
- Bridge: `result._meta['specr/anchors']` is read defensively (array-guarded);
  malformed entries are dropped, not thrown.
- Front-end: `applyFocus` is a no-op on an empty/invalid array; a target section
  with no rendered node contributes to the toast count rather than erroring.

## Testing

- **Unit tests** (no DB): `src/mcp/anchors.ts` helpers are pure — assert each
  derivation maps known result objects to the right `{section, specId?,
  paragraphId?}` anchors, and that `anchorsMeta([])` is `undefined`.
- **MCP integration test** (isolated Postgres on 5434 — never the demo DB on
  5432): one enriched handler (`handleSearchLibrary` or `handleCoordinationReport`)
  returns `_meta['specr/anchors']` with the correct anchor for a seeded fixture,
  and its text `content` is unchanged from today (regression guard).
- **Contract gate**: `pnpm test:integration` incl. the openapi contract test must
  stay green (expected: untouched, since REST is unchanged).
- **Front-end**: Playwright drives `applyFocus` with a synthetic anchor payload —
  Map active → nodes pulse + scroll; Settings active → toast — **no OpenAI spend**.
  One optional real end-to-end "firestopping" run to see the full loop.

## Branch / cherry-pick workflow

Per the standing rule (backend + openapi changes go on a separate branch from
`origin/main`, cherry-picked to the demo branch):

1. `feat/mcp-focus-anchors` worktree from `origin/main`: layer A + its MCP tests
   (+ openapi only if needed). Draft PR → `main`.
2. Cherry-pick that commit onto `feat/webgui-landed-features`.
3. Layers B + C commit directly on `feat/webgui-landed-features` (demo-only, no
   contract surface) — they ship in PR #324.

## Follow-up

Cross-machine chat-history persistence — its own brainstorm → spec → plan.
Currently `localStorage` (per-browser/per-machine); cross-machine needs a
server-side store keyed by a conversation identity (the demo has no user auth, so
the identity model is the crux of that design).
