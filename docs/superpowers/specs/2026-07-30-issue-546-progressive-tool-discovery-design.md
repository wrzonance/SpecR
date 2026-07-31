# Progressive tool discovery for the demo chat bridge (#546)

**Status:** approved, pending implementation plan
**Scope:** `examples/web_ui_demo/` plus a CI gate in `.github/workflows/ci.yml` —
no `src/` changes
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

### `/report` is in scope

An earlier scoping call limited this work to `/chat`. That is not achievable:
`server.mjs:595-598` wires `runReport` to the same `PROVIDER.makeCallModel()` and
`listOpenAiTools` this design deletes, and `report-bridge.mjs` is fully coupled to
the chat-completions IR (`completion.choices[0].message`, `.tool_calls`,
`role:'tool'` messages). **Revised decision: both surfaces move to the session
interface and both get progressive discovery.**

**Security invariant — the report catalog is the read-only pool, not the full
catalog.** `filterReadOnlyTools` exists so the reporting agent is structurally
incapable of mutating state during composition. If `/report` deferred all 131
tools, the model could *discover and call a write tool* — a real regression, not a
style issue. The partition for `/report` is therefore computed over
`filterReadOnlyTools(catalog)` (64 tools), and the execution-time `allowed`
allow-list stays as defense in depth.

**Report core set (3):** `list_projects`, `list_sections`, `search_library` —
exactly the discovery tools `REPORT_SYSTEM_PROMPT` already instructs the model to
use first.

`REPORT_SYSTEM_PROMPT` needs less rework than feared. It already enumerates the
grounded tools by name, which is precisely what both vendors recommend for
discoverability ("add a system prompt section describing available tool
categories"). It needs only a note that those tools are found by searching, not
preloaded.

**Token accounting changes.** `estimateTokens` walks message string content at
≈4 chars/token; opaque adapter transcripts make that impossible. The session
exposes real `usage` from each provider response instead. This is more accurate,
but `REPORT_TOKEN_BUDGET` (120,000) was calibrated against the approximation and
must be re-checked against real numbers — which will fall sharply once tool
definitions leave the prompt.

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

### CI gate

**CI runs none of the demo's tests.** `.github/workflows/ci.yml` has no reference
to `examples/`, yet the demo carries **306 passing `node --test` tests**. That gap
is the systemic reason a completely dead chat sidebar reached a user: the demo has
real coverage and no enforcement.

This PR adds the gate:

```yaml
- name: Demo unit tests
  run: node --test "examples/web_ui_demo/*.test.mjs"
```

All 306 pass today, so it goes green on arrival. Without it, every test written
for this issue — including the regression test — is decorative.

## Risks and open items

- **Residual `tools` array cap on the Responses API when all but the core set are
  deferred is undocumented** (Anthropic documents 10,000). **Not verified against
  the live API in this implementation** — the implementing agent does not make
  live provider calls (see project convention); this is left for the user to
  confirm with a real key before relying on the demo in production. What IS
  verified: `providers/catalog-regression.test.mjs` proves the wire request for a
  131-tool catalog carries 5 live function tools + 1 `tool_search` tool + 126
  `defer_loading:true` entries — i.e. the code sends the right SHAPE. Whether the
  Responses API accepts that shape without its own residual cap remains open.
  Regardless of outcome, the guard **fails loudly rather than truncating**: silent
  truncation is the failure mode that produces a demo that looks fine and answers
  wrong. **Action for the user:** run one real `/chat` turn with
  `OPENAI_API_KEY` + `OPENAI_MODEL=gpt-5.6-luna` set (see PR Testing checklist)
  and record the result here.
- **Namespacing not adopted.** OpenAI recommends grouping deferred functions into
  namespaces of <10 for search quality. SpecR's 131 names are flat `snake_case`.
  Ship flat; treat namespacing as a measured follow-up, because renaming tools
  ripples into `contract-map.ts` and the CI parity gates.
- **LOC.** Will **exceed** the 500-line `loc-check` warn threshold, now that both
  surfaces migrate. Warn-only, and the change is genuinely one indivisible unit —
  the IR cannot be deleted for one caller and kept for the other — but the
  reviewer burden is real and is flagged up front rather than at PR time.
- **Report quality re-verification.** Rewriting `REPORT_SYSTEM_PROMPT` for
  discovery can change report output. Reports must be spot-checked against
  pre-change behavior, not just asserted to run — left to the user, since it
  requires a live provider call.
- **No ADR.** Demo-only change; ADRs are `src/`-scoped in this repo.
- **Task-7 correction found during implementation (not a plan defect this doc
  originally flagged, but real).** The plan's literal `report-bridge.mjs`
  replacement code, if implemented verbatim, would have introduced two
  regressions the plan's own tests didn't catch: (1) it checked the tool-call
  budget once AFTER an entire round's calls had already executed, silently
  loosening `REPORT_MAX_TOOL_CALLS` for any single model turn emitting several
  calls at once; (2) it emitted a single `{n, detail}` step event per call, but
  `js/compose.js`'s `renderStep` requires the two-phase
  `{n, tool, label, status:'running'}` → `{...,status:'done'|'error'}` pair to
  key its step rows and toggle their CSS state — the literal code would have
  shipped blank, never-resolving report steps. Both were verified by direct
  reads of the pre-migration `report-bridge.mjs` and `js/compose.js` before
  implementing, and the shipped code restores both behaviors while still
  migrating onto the session interface. See `report-bridge.test.mjs`'s
  `'runReport stops mid-batch when the per-call budget is exhausted'` and the
  `defence in depth` test for the pinning coverage.
- **Second plan gap found during implementation:** `server.report.test.mjs`'s
  black-box mock still spoke the retired `POST /v1/chat/completions` wire and
  its `tools/list` fixture carried no `REPORT_CORE_TOOLS` name, which would
  make the real adapter's `splitCoreAndDeferred` throw on an all-deferred
  catalog. Neither the plan's file list nor its "Notes for the implementer"
  mentioned this file. It now mocks `POST /v1/responses` and includes
  `list_projects` in its fixture.

## References

- [MCP client best practices — progressive discovery](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)
- [Anthropic — tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Anthropic — advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- [OpenAI — tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [OpenAI — function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI — migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)
