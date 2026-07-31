# Progressive tool discovery for the demo chat bridge (#546)

**Status:** approved, pending implementation plan
**Scope:** `examples/web_ui_demo/` only — no `src/` changes
**Issue:** [#546](https://github.com/wrzonance/SpecR/issues/546)

## Problem

The demo web UI's MCP chat sidebar is non-functional. Every message fails:

```
Invalid 'tools': array too long. Expected an array with maximum length 128,
but got an array with length 131 instead.
```

`listOpenAiTools()` (`server.mjs:295`) hands the model every tool the MCP server
exposes. With the default `MCP_ALLOWED_TIERS=read,write` that is 131 tools
(64 read + 67 write), exceeding OpenAI's hard cap of 128. `/report` is unaffected —
it filters to the 64 read-only tools (`report-bridge.mjs:213`).

The failure is monotonic: every tool added to `TOOL_TIERS` makes it worse. A
one-time trim is not a fix.

### Why the cap is the wrong target

Vendor guidance treats 128 as a symptom, not the limit that matters:

| Source | Guidance |
|---|---|
| OpenAI function-calling guide | Fewer than **20** functions at the start of a turn |
| Anthropic tool-search docs | Selection accuracy degrades past **30–50** tools |
| MCP client best practices | Switch to progressive discovery past **1–5%** of context |

A 584-tool routing study (June 2026) measured accuracy falling 16–23 points at
scale. Clamping to 128 yields a request that succeeds and answers badly.

## Decision

Adopt **progressive tool discovery** via each provider's *native* tool-search
support. Do not build a custom retrieval layer.

Both vendors ship this, but only on specific surfaces:

| | Anthropic | OpenAI |
|---|---|---|
| Surface | Messages API (already used) | **Responses API** |
| Model floor | Opus 4.5+ / Sonnet 4.5+ / Haiku 4.5 | **gpt-5.4+** |
| Enable | `tool_search_tool_bm25_20251119` + `defer_loading` | `{"type":"tool_search"}` + `defer_loading` |

The OpenAI path therefore migrates from Chat Completions to the Responses API.

### Alternatives rejected

- **Clamp the array to 128.** Produces confidently wrong answers (see above).
- **Custom BM25 retrieval, provider-agnostic.** ~250 lines of ranking, synonym
  mapping and injection bookkeeping, plus tests, to reimplement a protocol
  feature both vendors now provide. Rejected as durable maintenance cost.
- **Native on Anthropic, custom on OpenAI.** Chat would behave differently
  depending on `LLM_PROVIDER` — two mechanisms, two test matrices.

## Architecture

Both providers require **provider-native items echoed back** through the tool
loop: OpenAI Responses with `store: false` replays every `reasoning`,
`function_call`, `function_call_output` and tool-search item; Anthropic passes
`server_tool_use` and `tool_search_tool_result` blocks back unchanged. Neither is
representable in the demo's current internal chat-completions shape.

So the shared abstraction changes from a **data shape** to an **interface**, and
`llm-providers.mjs` is deleted.

```
createSession({ system, userMessages, tools }) → session
  session.send()                → { text, toolCalls: [{ id, name, args }] }
  session.addToolResults([{ id, text }])
  session.finalize()            → { text }        // forced final answer
```

The transcript is **private to the adapter**. `runChat` never sees a provider
shape again; it loops `send` → execute against MCP → `addToolResults`.

`finalize()` forces a closing answer when the round cap is hit. It does **not**
send an empty tool list: the Messages API rejects `tool_use`/`tool_result`
history when the request defines no tools, which is why the current
`makeAnthropicCallModel` re-sends its last tool list. Each adapter keeps its
declared tools and suppresses new calls via its own tool-choice mechanism.

`runChat` retains a round cap. Native discovery can consume a round before any
real work happens, so `CHAT_MAX_TOOL_ROUNDS` rises from 6 to 8.

The UI tool trace (`body.data.toolCalls`) continues to list only tools executed
against MCP. Tool-search calls resolve provider-side and are deliberately absent
from the trace — it reports what touched SpecR, not what the model browsed.

```
examples/web_ui_demo/
  providers/
    openai.mjs      Responses API + {type:'tool_search'} + defer_loading
    anthropic.mjs   Messages API + tool_search_tool_bm25 + defer_loading
    tools.mjs       splitCoreAndDeferred() — pure, provider-neutral
    index.mjs       adapter selection from LLM_PROVIDER
  llm-providers.mjs   ← deleted
```

### Tool declaration

`splitCoreAndDeferred()` is the only shared logic. It partitions the MCP catalog
into an always-loaded core set and defers the rest; each adapter renders that
partition into its own wire format.

**Core set (5, non-deferred):** `list_projects`, `list_sections`,
`search_library`, `get_spec`, `get_references`. Both vendors recommend 3–5
always-loaded tools, and both reject an all-deferred request — the core set is a
protocol requirement, not an optimization.

`get_references` earns its slot from usage, not architecture: the chat greeting
(`index.html:735`) advertises three example questions, and *"which sections cite
09 22 00?"* is one of them. A third advertised question — *"are there open review
comments?"* (`open_comments_report`) — was considered and **deliberately left
deferred** to hold the core set at five. It costs one discovery round on first
use, which is the accepted trade.

Core slots buy a fast, reliable *first* turn at the cost of context on every
request. They do not affect capability: every deferred tool stays reachable via
search.

Core tools absent from the catalog (tier-gated away) must not produce phantom
entries; the partition is computed against what `tools/list` actually returned.

### System prompt

Both vendors recommend naming the available tool categories so the model knows
what to search for. Add one line enumerating SpecR's domains (projects, specs,
paragraphs, packages, revisions, headers/footers, language rules, coordination,
reporting).

### Statelessness

Preserved. OpenAI uses `store: false` with
`include: ["reasoning.encrypted_content"]`, echoing items each round. The demo
server continues to persist nothing; the browser keeps the transcript.

## Configuration

| Setting | From | To |
|---|---|---|
| `OPENAI_MODEL` | `gpt-4o-mini` | `gpt-5.6-luna` |
| OpenAI endpoint | `${OPENAI_BASE}/chat/completions` | `${OPENAI_BASE}/responses` |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | `claude-sonnet-4-6` |

`gpt-5.6-luna` is $0.20/$1.20 per M against `gpt-4o-mini`'s $0.15/$0.60 — a
marginal increase, and the cheapest tier clearing the gpt-5.4 floor.

`claude-sonnet-4-6` replaces a flagship default on a Q&A sidebar: materially
cheaper than Opus 4.8, stronger tool selection than Haiku. Both defaults are
overridable via `.env`.

**No boot-time model validation.** A regex guessing whether a model string clears
the gpt-5.4 floor will break on the next model name. The provider returns a
precise error; surfacing it well is the error-handling work below. `.env.example`
and the demo README document the floor.

## Error handling

Root cause of the raw-JSON chat bubble is server-side: `callOpenAI` concatenates
the provider's response body into `err.message` (`server.mjs:346`), which
`handleChat` then prefixes. The UI renders faithfully. Fixed in three layers:

1. **Adapter** parses the provider error body into a structured error: clean
   `message`, provider `code`, `status`, and raw `detail` kept *beside* the
   message, never glued into it.
2. **`/chat`** responds `{ success: false, code, error, detail }`.
3. **`chat.js`** renders an error bubble: one plain-language line, with `detail`
   behind a `<details>` disclosure.

This applies CLAUDE.md's progressive-disclosure rule to failures — a spec editor
reads *"The chat model rejected the request. This demo needs an OpenAI model of
gpt-5.4 or newer."*, and the technical detail stays one click away. The existing
`no-key` message and the network-failure branch fold into the same renderer.

All error nodes are built with `createElement` + `textContent`; no `innerHTML`
enters the error path.

Adapter errors follow the repo's chaining convention — each catch site that adds
meaning chains `cause`, so the error reads as a why-chain from provider to UI.

## Testing

Adapters take an injected `fetch`, following the `deps` pattern already used by
`report-bridge.mjs`, so wire shapes are assertable without network.

| Test file | Pins |
|---|---|
| `providers/tools.test.mjs` | Core non-deferred, rest deferred, never all-deferred, no phantom core entry when tier-gated |
| `providers/openai.test.mjs` | Flat function tools, `tool_search` present, `store: false`, encrypted reasoning echoed across rounds |
| `providers/anthropic.test.mjs` | bm25 tool present; `server_tool_use` / `tool_search_tool_result` preserved verbatim; no `tool_result` for a `srvtoolu_` id |
| `chat-error.test.mjs` | OpenAI body, Anthropic body, network failure, non-JSON body all normalize to message + code + detail |

Regression test named for the symptom, per repo convention:
`'chat: 131-tool catalog is deferred, not sent as 131 live tools'`.

`llm-providers.test.mjs` and `server.anthropic.test.mjs` retire with the module
they cover.

Manual verification against both providers using the reported failing query:
*"show me the submittals section in the architectural lighting control system spec"*.

## Risks and open items

- **Residual `tools` array cap on the Responses API when all but the core set are
  deferred is undocumented** (Anthropic documents 10,000). **Resolution: verify
  against the live API during implementation** — one request carrying the full
  131-tool catalog (5 core, 126 deferred) — and record the result here before the
  PR opens. Regardless of outcome, the guard **fails loudly rather than
  truncating**: silent truncation is the failure mode that produces a demo that
  looks fine and answers wrong.
- **Namespacing not adopted.** OpenAI recommends grouping deferred functions into
  namespaces of <10 for search quality. SpecR's 131 names are flat `snake_case`.
  Ship flat; treat namespacing as a measured follow-up, because renaming tools
  ripples into `contract-map.ts` and the CI parity gates.
- **LOC.** Likely near or over the 500-line `loc-check` warn threshold even with
  `llm-providers.mjs` deleted. Warn-only; flagged for the reviewer up front.
- **No ADR.** Demo-only change; ADRs are `src/`-scoped in this repo.

## References

- [MCP client best practices — progressive discovery](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)
- [Anthropic — tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Anthropic — advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- [OpenAI — tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [OpenAI — function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI — migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)
