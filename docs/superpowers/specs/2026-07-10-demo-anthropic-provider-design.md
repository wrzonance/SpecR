# Demo LLM bridge: Anthropic provider support — design

**Date:** 2026-07-10 · **Issue:** [#444](https://github.com/wrzonance/SpecR/issues/444) · **Scope:** `examples/web_ui_demo` only — `src/` is untouched, so no ADR (demo-only decisions don't get ADRs).

## Problem

The demo's two LLM features — the "Ask SpecR" chat sidebar (`POST /chat`) and the agent-driven grounded-reporting Compose tab (`POST /report`) — speak only to OpenAI. `server.mjs` owns `OPENAI_API_KEY` and a raw-fetch `callOpenAI()`; `report-bridge.mjs` runs the read-only tool loop against an injected `callModel`. Organizations hold **either** OpenAI **or** Anthropic usage-based API keys under enterprise data-protection agreements; whichever key an org has must be enough to iterate SpecR's MCP functionality against proprietary specifications.

## Decisions (settled with maintainer)

1. **Explicit provider selection**: `LLM_PROVIDER=openai|anthropic` in `.env`. Keys alone never switch the provider.
2. **Raw fetch, no SDK**: a `callAnthropic()` symmetric to the existing raw-fetch `callOpenAI()`. The demo has no `package.json`; adding `@anthropic-ai/sdk` would put a demo-only dep in the product's root dependency tree.
3. **Default model `claude-opus-4-8`**, override via `ANTHROPIC_MODEL`.
4. **No ADR** — demo is a disposable proving ground; an ADR is minted only if/when this pattern graduates into `src/`.

## Architecture

The demo's internal lingua franca **stays the OpenAI chat-completions shape** — `{choices:[{message}]}`, `message.tool_calls`, `{role:'tool', tool_call_id}` — because that is what the pure, tested `report-bridge.mjs` and `runChat()` already speak. Anthropic support is a **translation adapter at the wire boundary** (the WrzDJ `adapters/` + `tool_translation` pattern, minus streaming). `report-bridge.mjs` is not modified.

```
chat.js / compose.js ──POST /chat|/report──▶ server.mjs
                                              ├─ PROVIDER = resolveProvider(env)   (boot)
                                              ├─ runChat / runReport  (OpenAI-shaped messages)
                                              │        └─ provider.callModel(messages, tools)
                                              │             ├─ openai   → callOpenAI (unchanged)
                                              │             └─ anthropic → callAnthropic
                                              │                  └─ llm-providers.mjs translation
                                              └─ MCP tool calls → POST {API_BASE}/mcp  (unchanged)
```

## Components

### 1. Config & provider resolution (`server.mjs`)

- `LLM_PROVIDER` — `openai` (default, full back-compat) or `anthropic`. **Any other value: log a clear error and `process.exit(1)`** at boot (fail-fast env rule).
- New env, mirroring the OpenAI trio:
  - `ANTHROPIC_API_KEY` — read only by the demo server; never sent to the browser (same guarantee as `OPENAI_API_KEY`).
  - `ANTHROPIC_MODEL` — default `claude-opus-4-8`.
  - `ANTHROPIC_BASE_URL` — default `https://api.anthropic.com` (enterprise gateways/proxies; also how tests point at a mock).
- Resolution yields one active provider object `{ name, model, hasKey, makeCallModel, noKeyError }`. The *unselected* provider's key is ignored entirely.
- Missing key for the selected provider degrades exactly like today: `/chat` and `/report` answer `code:'no-key'` with a provider-specific message (`'ANTHROPIC_API_KEY not configured on the demo server'`).
- Boot log names the provider: `Chat bridge: enabled (anthropic, model claude-opus-4-8)` / `disabled (set ANTHROPIC_API_KEY in .env)`.

### 2. Translation adapter — new file `examples/web_ui_demo/llm-providers.mjs`

Pure functions, no I/O, unit-testable without a network:

- `toAnthropicTools(tools)` — `{type:'function', function:{name, description, parameters}}` → `{name, description, input_schema}`. The internal `__readOnly` flag must not leak onto the wire (same rule the OpenAI path already enforces).
- `toAnthropicRequest(messages)` → `{ system, messages }`:
  - leading `role:'system'` message → top-level `system` string;
  - assistant message with `tool_calls` → assistant content blocks `[{type:'text'}?, {type:'tool_use', id, name, input}]` (arguments JSON-parsed; malformed JSON → `{}`);
  - **consecutive `role:'tool'` messages merge into ONE user message** of `{type:'tool_result', tool_use_id, content}` blocks — the Messages API requires all results for an assistant turn in a single user message;
  - plain user/assistant string messages pass through as text content.
- `fromAnthropicResponse(response)` — content blocks → `{choices:[{message:{role:'assistant', content: <joined text>, tool_calls?}}]}`; `tool_use` blocks → `tool_calls: [{id, type:'function', function:{name, arguments: JSON.stringify(input)}}]` (omitted when there are none, so `runChat`'s `if (!calls || calls.length === 0)` exit works unchanged).

### 3. `callAnthropic()` (`server.mjs`)

Symmetric to `callOpenAI`: raw `fetch` to `${ANTHROPIC_BASE}/v1/messages`, 60 s `AbortController`, non-OK → `Error('Anthropic <status>: <detail slice>')`. Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`. Body: `{ model, max_tokens: 16000, system?, messages, tools?, tool_choice? }`. `thinking` is omitted — on Opus 4.8 that runs without thinking, keeping the chat sidebar responsive.

**Tools-disabled final turn.** `runChat`'s round-cap and `runReport`'s forced close call `callModel(messages, [])`/`(messages, undefined)`. Anthropic rejects requests whose history contains `tool_use`/`tool_result` blocks but define no `tools`. Fix lives in the per-request wrapper produced by `makeCallModel()`:

```js
// anthropic provider — one instance per /chat or /report request
function makeCallModel() {
  let lastTools = [];
  return (messages, tools) => {
    if (tools && tools.length > 0) {
      lastTools = tools;
      return callAnthropic(messages, tools, undefined);       // model decides
    }
    return callAnthropic(messages, lastTools, { type: 'none' }); // history valid, no new calls
  };
}
```

The OpenAI `makeCallModel()` returns the existing passthrough. `runChat` gains a `callModel` parameter (was hard-wired to `callOpenAI`); `handleChat`/`handleReport` construct one wrapper per request and inject it (the `/report` path already injects `deps.callModel` — only the construction site changes).

### 4. Response & UI surface

- `/chat` success payload: `data.model` stays, add `data.provider`.
- `/report` `done` event: `model` stays, add `provider`.
- `js/chat.js` + `js/compose.js`: on `code:'no-key'`, prefer the server's `error` text (single source of truth), falling back to a provider-neutral sentence. Two-line change each; comments updated from "OpenAI-backed" to provider-neutral phrasing.

### 5. `.env.example` + README

- Rename the section to "LLM-backed features"; document `LLM_PROVIDER` and the `ANTHROPIC_*` trio with the same server-side-only guarantee note; keep the OpenAI block intact.
- One comment addressed at the driving use case: orgs with usage-based enterprise keys (OpenAI **or** Anthropic) can point the demo at whichever provider their data-protection agreement covers.
- README config table gains the four new vars. Launchers (`Start-SpecR.sh`/`.bat`) need no changes — they already pass `.env` through.

## Error handling

- Boot: invalid `LLM_PROVIDER` → stderr message + exit 1.
- Request time: missing selected-provider key → `code:'no-key'` degraded reply (never a crash); Anthropic HTTP errors surface as `chat failed: Anthropic <status>: …` through the existing 502 path; timeouts via the existing 60 s abort.
- Adapter: malformed `tool_calls[].function.arguments` JSON → `{}` (mirrors `execToolCall`'s tolerance).

## Testing (`node --test`, mirroring existing demo tests; not in vitest/CI)

1. **`llm-providers.test.mjs`** — unit tests for the three pure functions: tool mapping (incl. `__readOnly` never leaking), system extraction, assistant `tool_calls` → `tool_use`, **consecutive tool-result merge into one user message**, text-only and mixed responses, `tool_calls` omitted when no `tool_use` blocks.
2. **`server.anthropic.test.mjs`** — black-box clone of `server.report.test.mjs`: spawn `server.mjs` with `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=test-key`, `ANTHROPIC_BASE_URL=http://127.0.0.1:<mock>`; mock plays `/mcp` + `/v1/messages` (first reply `tool_use`, second plain text). Asserts:
   - `/chat` end-to-end reply + `provider:'anthropic'` + tool trace;
   - `/report` NDJSON stream (step → usage → done);
   - the wire request carries `input_schema` (not `parameters`) and never `__readOnly`;
   - the forced final turn sends non-empty `tools` + `tool_choice:{type:'none'}`;
   - no-key boot (`ANTHROPIC_API_KEY` unset) → `/chat` answers `code:'no-key'` naming ANTHROPIC_API_KEY.
3. **Regression**: existing `server.report.test.mjs` and friends stay green with no `LLM_PROVIDER` set (default `openai` path byte-compatible).

## Out of scope

- Streaming responses from either provider (demo is non-streaming today).
- Runtime provider switching in the UI (explicitly rejected in favor of `LLM_PROVIDER`).
- Any change under `src/` (including the MCP server) — and therefore no ADR.
- Azure OpenAI / Bedrock / Vertex routing beyond what `*_BASE_URL` already enables.
