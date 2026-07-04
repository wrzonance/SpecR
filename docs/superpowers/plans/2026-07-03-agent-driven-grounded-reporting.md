# Agent-Driven Grounded Reporting (web_ui_demo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Compose" affordance to `examples/web_ui_demo` where an LLM agent drives grounded report composition — calling SpecR's read-only MCP tools, streaming its tool-call steps, and rendering a cited narrative whose every source is click-through into the tree/audit views.

**Architecture:** A new read-only demo bridge endpoint (`POST /report`) runs an OpenAI tool-calling loop against SpecR's stateless MCP endpoint, restricted to `readOnlyHint` tools, and streams progress as NDJSON events (`step` / `usage` / `done` / `error`). A new client module (`js/compose.js`) renders the panel, consumes the stream, and reuses the existing anchor/`audit.showAnchor` machinery for click-through citations. Pure orchestration logic lives in `report-bridge.mjs` so it is unit-testable with mocks.

**Tech Stack:** Node 22 (built-in `http`, `node:test`), vanilla ESM browser JS, the existing MCP `_meta['specr/anchors']` channel, OpenAI chat-completions tool-calling.

## Global Constraints

- **PDF download is OUT OF SCOPE** (blocker #352 open). Ship a visibly **disabled** "Download PDF" affordance with a code comment + UI note referencing #352. PR is `Refs #353`, not `Closes #353`.
- **Example/POC code only** — `examples/web_ui_demo` is NOT linted, type-checked, or tested by CI (`pnpm lint`/`format:check`/`test` target `src/` only). Keep it clean and consistent with the demo's existing vanilla-ESM style: 2-space indent, single quotes, semicolons, `printWidth` 100, small pure functions, immutable patterns, no framework.
- **The product holds no LLM key.** The OpenAI key lives ONLY in the demo bridge (`server.mjs`), read from env, never sent to the browser. Never hardcode a key.
- **Read-only by construction.** The reporting flow must call only MCP tools whose `annotations.readOnlyHint === true`. This is the demo's answer to the "human-in-the-loop for writes" footgun — the composer physically cannot write.
- **Deterministic grounding.** Citations are built from the deterministic `_meta['specr/anchors']` each tool returns, NOT parsed out of LLM prose. The narrative prose may vary run-to-run; the cited facts do not.
- **Bounded cost.** Cap tool rounds, total tool calls, and surface a running token estimate + rounds used so the "hundreds of DOCX" case cannot run away.
- **No backend/src changes.** The demo must not require changes under `src/`. Everything here is under `examples/web_ui_demo/` plus docs.

---

## File Structure

- `examples/web_ui_demo/report-bridge.mjs` (new) — pure orchestration helpers + the injectable `runReport` loop. No `node:http`, no direct `fetch` at module top; I/O is injected so it is testable.
- `examples/web_ui_demo/report-bridge.test.mjs` (new) — `node --test` unit tests for the pure helpers + loop, with mocked openai/mcp.
- `examples/web_ui_demo/server.mjs` (modify) — add the `POST /report` NDJSON-streaming route; delegate to `report-bridge.mjs`.
- `examples/web_ui_demo/js/compose.js` (new) — the Compose panel controller (`initCompose`).
- `examples/web_ui_demo/js/app.js` (modify) — import + init `initCompose`, provide state accessors + `onCite` navigation.
- `examples/web_ui_demo/index.html` (modify) — nav tab + panel skeleton for `data-view="compose"`.
- `examples/web_ui_demo/css/app.css` (modify) — Compose panel styles.
- `examples/web_ui_demo/README.md` (modify) — document the Compose view.

---

### Task 1: Pure report-bridge helpers + tests

**Files:**
- Create: `examples/web_ui_demo/report-bridge.mjs`
- Test: `examples/web_ui_demo/report-bridge.test.mjs`

**Interfaces:**
- Produces:
  - `REPORT_SYSTEM_PROMPT: string`
  - `filterReadOnlyTools(tools: OpenAiTool[]): OpenAiTool[]` — keep only tools whose `.function` corresponds to a `readOnlyHint` tool. Since `listOpenAiTools` flattens MCP tools, this filters on a `readOnly` boolean stamped during discovery (see Task 3 discovery shape) — for the pure helper it filters `tools.filter(t => t.__readOnly === true)`.
  - `humanizeToolStep(name: string, args: object): string` — e.g. `compare_specs` → `'Comparing specs across 2 sources…'`, `coordination_report` → `'Reading coordination report…'`, generic → `'Calling <name>…'`.
  - `dedupeAnchors(anchors: Anchor[]): Anchor[]` — same key/`≤50` cap logic as `server.mjs`.
  - `estimateTokens(messages: {content?:string}[]): number` — `ceil(totalChars / 4)`.
  - `buildReportMessages(request: string, scope: {label?:string} | undefined, systemPrompt: string): Message[]`.
  - `async runReport({ request, scope, deps, limits, emit }): Promise<{ reply, citations, toolCalls, usage }>` where `deps = { listTools, callModel, execTool }`, `limits = { maxRounds, maxToolCalls, tokenBudget }`, `emit(event)` is called with `{type:'step'|'usage', ...}`.

- [ ] **Step 1: Write the failing test**

```js
// examples/web_ui_demo/report-bridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterReadOnlyTools,
  humanizeToolStep,
  dedupeAnchors,
  estimateTokens,
  buildReportMessages,
  runReport,
  REPORT_SYSTEM_PROMPT,
} from './report-bridge.mjs';

test('filterReadOnlyTools keeps only read-only tools', () => {
  const tools = [
    { function: { name: 'coordination_report' }, __readOnly: true },
    { function: { name: 'create_project' }, __readOnly: false },
  ];
  const kept = filterReadOnlyTools(tools);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].function.name, 'coordination_report');
});

test('humanizeToolStep gives a friendly label for known tools', () => {
  assert.match(humanizeToolStep('compare_specs', { sources: ['a', 'b'] }), /compar/i);
  assert.match(humanizeToolStep('coordination_report', {}), /coordination/i);
  assert.match(humanizeToolStep('mystery_tool', {}), /mystery_tool/);
});

test('dedupeAnchors collapses duplicates and caps at 50', () => {
  const dupes = Array.from({ length: 60 }, (_, i) => ({ section: `09 ${i} 00`, specId: 's', paragraphId: 'p' }));
  const withDup = [...dupes, { section: '09 0 00', specId: 's', paragraphId: 'p' }];
  const out = dedupeAnchors(withDup);
  assert.equal(out.length, 50);
  assert.ok(out.every((a) => typeof a.section === 'string' && a.section !== ''));
});

test('estimateTokens approximates 4 chars per token', () => {
  assert.equal(estimateTokens([{ content: 'x'.repeat(40) }]), 10);
});

test('buildReportMessages seeds system + user with the scope label', () => {
  const msgs = buildReportMessages('compare 03 30 00', { label: 'Projects: A, B' }, REPORT_SYSTEM_PROMPT);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs.at(-1).role, 'user');
  assert.match(msgs.at(-1).content, /03 30 00/);
  assert.match(msgs.at(-1).content, /A, B/);
});

test('runReport runs the tool loop, emits steps, returns deterministic citations', async () => {
  const anchor = { section: '03 30 00', specId: 's1', paragraphId: 'p1' };
  const deps = {
    listTools: async () => [{ function: { name: 'compare_specs' }, __readOnly: true }],
    callModel: async (messages) => {
      const priorTool = messages.some((m) => m.role === 'tool');
      return priorTool
        ? { choices: [{ message: { role: 'assistant', content: 'Section 03 30 00 diverges.' } }] }
        : {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 't1', function: { name: 'compare_specs', arguments: '{"sources":["s1","s2"]}' } },
                  ],
                },
              },
            ],
          };
    },
    execTool: async () => ({ text: '{"rows":[]}', ok: true, anchors: [anchor] }),
  };
  const steps = [];
  const out = await runReport({
    request: 'compare 03 30 00',
    scope: undefined,
    deps,
    limits: { maxRounds: 4, maxToolCalls: 8, tokenBudget: 100000 },
    emit: (e) => steps.push(e),
  });
  assert.match(out.reply, /diverges/);
  assert.deepEqual(out.citations, [anchor]);
  assert.ok(steps.some((s) => s.type === 'step' && s.tool === 'compare_specs'));
  assert.equal(out.toolCalls[0].ok, true);
});

test('runReport stops at maxToolCalls and still returns a reply', async () => {
  const deps = {
    listTools: async () => [{ function: { name: 'list_projects' }, __readOnly: true }],
    callModel: async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 't', function: { name: 'list_projects', arguments: '{}' } }],
          },
        },
      ],
    }),
    execTool: async () => ({ text: '[]', ok: true, anchors: [] }),
  };
  const out = await runReport({
    request: 'x',
    scope: undefined,
    deps,
    limits: { maxRounds: 10, maxToolCalls: 2, tokenBudget: 100000 },
    emit: () => {},
  });
  assert.ok(out.toolCalls.length <= 2);
  assert.equal(typeof out.reply, 'string');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/report-bridge.test.mjs`
Expected: FAIL — `Cannot find module './report-bridge.mjs'` (or export-not-found).

- [ ] **Step 3: Write the implementation**

Create `examples/web_ui_demo/report-bridge.mjs` with:
- `REPORT_SYSTEM_PROMPT` — instructs: you compose grounded CSI spec reports by calling read-only MCP tools; discover ids first (`list_projects`/`list_sections`/`search_library`); prefer grounded reporting tools (`compare_specs`, `coordination_report`, `get_spec_diff`, `get_references`, `submittal_register`, `open_comments_report`, `get_onboarding_report`); NEVER invent content/section numbers/ids; when a tool returns empty, say "not present" plainly; keep scope narrow (name specific sections/projects, don't diff the whole corpus); end with a concise cited narrative citing section numbers.
- `filterReadOnlyTools`, `humanizeToolStep` (a small `Map` of known-tool phrasings + generic fallback), `dedupeAnchors` (ported from server.mjs), `estimateTokens`, `buildReportMessages`.
- `runReport({ request, scope, deps, limits, emit })`: build messages; `tools = filterReadOnlyTools(await deps.listTools())`; loop up to `limits.maxRounds`, calling `deps.callModel(messages, tools)`; push assistant message; if no `tool_calls`, return `{reply, citations: dedupeAnchors(collected), toolCalls, usage}`; else for each call: `emit({type:'step', n, tool, label: humanizeToolStep(...), status:'running'})`, run `deps.execTool(call)`, push tool message, record `toolCalls.push({name, ok})`, merge `anchors`, `emit({type:'step', ..., status: ok?'done':'error'})`, `emit({type:'usage', rounds, toolCalls: count, tokens: estimateTokens(messages)})`; break out when `toolCalls.length >= limits.maxToolCalls` or `estimateTokens(messages) > limits.tokenBudget`, then force one final `deps.callModel(messages, [])` for the closing narrative. Return `usage = { rounds, toolCalls: count, tokens }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test examples/web_ui_demo/report-bridge.test.mjs`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/report-bridge.mjs examples/web_ui_demo/report-bridge.test.mjs
git commit -m "feat(demo): pure report-bridge orchestration + node --test coverage"
```

---

### Task 2: `/report` NDJSON streaming endpoint in server.mjs

**Files:**
- Modify: `examples/web_ui_demo/server.mjs`

**Interfaces:**
- Consumes from Task 1: `REPORT_SYSTEM_PROMPT`, `runReport`, `buildReportMessages`.
- Produces: `POST /report` — request `{ request: string, scope?: { label?: string } }`; response `Content-Type: application/x-ndjson`, one JSON object per line: `{type:'step',...}` | `{type:'usage',...}` | `{type:'done', reply, citations, toolCalls, usage, model}` | `{type:'error', error}`. No key ⇒ single `{type:'error', code:'no-key', error}` line + 200.

- [ ] **Step 1: Add a read-only tool-discovery variant**

In `server.mjs`, add `listOpenAiReadOnlyTools()` that calls `mcpRpc('tools/list', {})` and maps each tool to the OpenAI shape (like `listOpenAiTools`) but also stamps `__readOnly: tool.annotations?.readOnlyHint === true`. Keep the existing `listOpenAiTools` untouched (used by `/chat`).

- [ ] **Step 2: Add the handler**

Add `handleReport(req, res)`:
- If `!OPENAI_API_KEY`, write one NDJSON line `{type:'error', code:'no-key', error:'OPENAI_API_KEY not configured on the demo server'}` and end.
- Parse+validate body: `request` non-empty string (≤4000 chars), optional `scope.label` string. On bad body: `{type:'error', error:'…'}`.
- Set headers: `content-type: application/x-ndjson; charset=utf-8`, `cache-control: no-cache`, `connection: keep-alive`. Helper `emit(obj)` = `res.write(JSON.stringify(obj) + '\n')`.
- Call `runReport({ request, scope, emit, limits: { maxRounds: REPORT_MAX_ROUNDS, maxToolCalls: REPORT_MAX_TOOL_CALLS, tokenBudget: REPORT_TOKEN_BUDGET }, deps: { listTools: listOpenAiReadOnlyTools, callModel: (m, t) => callOpenAI(m, t), execTool: execToolCall } })`.
- On success: `emit({type:'done', ...result, model: OPENAI_MODEL})`; on throw: `emit({type:'error', error: 'report failed: '+err.message})`. Always `res.end()`.
- Add module constants near the chat caps: `REPORT_MAX_ROUNDS = 8`, `REPORT_MAX_TOOL_CALLS = 12`, `REPORT_TOKEN_BUDGET = 120000`.

- [ ] **Step 3: Route it**

In the `createServer` callback, before the `isApiPath` check, add: `if (url.pathname === '/report') { if (req.method !== 'POST') { sendJson(res, 405, …) } else void handleReport(req, res); return; }`.

- [ ] **Step 4: Manual smoke (keyless path)**

Run (no OPENAI_API_KEY): start `node server.mjs` against the running API, then
`curl -sN -X POST localhost:3353/report -H 'content-type: application/json' -d '{"request":"x"}'`
Expected: one line `{"type":"error","code":"no-key",...}`.

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/server.mjs
git commit -m "feat(demo): read-only /report NDJSON streaming bridge (grounded reporting)"
```

---

### Task 3: Compose client panel + wiring

**Files:**
- Create: `examples/web_ui_demo/js/compose.js`
- Modify: `examples/web_ui_demo/index.html`, `examples/web_ui_demo/js/app.js`, `examples/web_ui_demo/css/app.css`

**Interfaces:**
- Consumes: `POST /report` NDJSON stream.
- Produces: `initCompose({ getProjects, getSpecs, onCite }): { refresh }`. `onCite(anchor)` navigates: called by app.js as `(anchor) => { showView('report'); void audit.showAnchor(anchor); }`.

- [ ] **Step 1: index.html — nav tab + panel**

Add after the Submittal tab: `<button class="view-tab" type="button" data-view="compose">Compose</button>`.
Add a `<section class="app-view" id="view-compose" data-view-panel="compose" hidden>` containing: a header explaining "agent-driven grounded report — reads only, cites every source"; a read-only scope summary (`id="compose-scope"`); a `<textarea id="compose-input">` with example chips (`data-example` buttons); a Run button (`id="compose-run"`); a disabled Download-PDF button (`id="compose-pdf"` `disabled` `title="PDF export lands with #352"`); a cost/scope meter (`id="compose-meter"`); a live step list (`id="compose-steps"`); and the composed output + citations (`id="compose-output"`).

- [ ] **Step 2: compose.js — stream reader + render**

Implement `initCompose`. On Run: POST `{request, scope:{label}}` to `/report`, read `res.body.getReader()`, split NDJSON by `\n`, dispatch by `type`: `step` → append/update a step row (running→done/error); `usage` → update the meter (`rounds`, `toolCalls`, `~tokens`); `done` → render `reply` as escaped text + a "Sources (N)" list where each `citation` is a click-through chip calling `onCite(anchor)`; `error` → render the error (special-case `code:'no-key'` with the same copy as chat). Add a Regenerate button (re-runs same request) to demonstrate reproducibility. Escape all text via `textContent` (no innerHTML). Example chips fill the textarea.

- [ ] **Step 3: app.js — wire it**

Import `initCompose`; in `boot()` add `initCompose({ getProjects: () => projects, getSpecs: () => specs, onCite: (anchor) => { showView('report'); void audit.showAnchor(anchor); } })`. Store the controller if a `refresh()` on `showView('compose')` is useful (refresh scope chips from current projects/specs).

- [ ] **Step 4: css/app.css — styles**

Add styles for `.compose-*` mirroring the existing chat/report look (step rows with a running spinner dot, done/error states, citation chips reusing `.ref-link`-like affordances, disabled PDF button, meter). Keep the demo's existing color tokens.

- [ ] **Step 5: Manual verify (browser, if key available)**

Run the API + `node server.mjs` with a real `OPENAI_API_KEY`, load a project, open Compose, run "coordination report for the active project". Expected: steps stream, narrative renders, a Sources list appears, clicking a source opens the Report tab scrolled to the cited paragraph. (List as an unticked manual checkbox in the PR if no key is available in this environment.)

- [ ] **Step 6: Commit**

```bash
git add examples/web_ui_demo/js/compose.js examples/web_ui_demo/index.html examples/web_ui_demo/js/app.js examples/web_ui_demo/css/app.css
git commit -m "feat(demo): Compose panel — agent-driven grounded reporting with click-through citations"
```

---

### Task 4: README + finish

**Files:**
- Modify: `examples/web_ui_demo/README.md`

- [ ] **Step 1: Document the Compose view** in the "Workspace views" list and a dedicated subsection (what it does, read-only guarantee, deterministic citations, cost/scope meter, PDF deferred to #352, off without a key).
- [ ] **Step 2:** `node --test examples/web_ui_demo/report-bridge.test.mjs` green; `git status` clean.
- [ ] **Step 3: Commit** `docs(demo): document the Compose grounded-reporting view`.
- [ ] **Step 4:** superpowers:finishing-a-development-branch → option 2 (Push + draft PR). PR body: Why/What/Testing checkboxes + `## Design decisions` + `Refs #353` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Self-Review

**Spec coverage:**
- "reporting affordance (add-files/pick-scope, run, stream steps, view cited output, download PDF [deferred])" → Task 3 (scope chips, Run, streamed steps, cited output, disabled PDF).
- "wire agent loop to prefer grounded reporting tool" → Task 1 `REPORT_SYSTEM_PROMPT` + read-only tool set.
- "render citations as click-throughs into tree/audit views" → Task 3 `onCite` → `audit.showAnchor` (Task 3 Step 3).
- Footgun "No AI just because" → Compose is scoped to multi-spec/cross-project synthesis + NL slicing; deterministic buttons stay (documented in README + PR).
- Footgun "Show the grounding" → streamed `step` events + deterministic Sources list.
- Footgun "Determinism where it counts" → citations from `_meta` anchors; Regenerate demonstrates stable facts / varying prose.
- Footgun "Graceful not-present" → system prompt + real tool empties.
- Footgun "Scope/cost guardrails" → `maxRounds`/`maxToolCalls`/`tokenBudget` + `usage` meter.
- Footgun "Human-in-the-loop for writes" → read-only tool filter (`readOnlyHint`); composer cannot write.
- Non-goal (don't build #351/#352) → consumes existing tools; PDF disabled.

**Placeholder scan:** none — every code step shows real code or an exact command.

**Type consistency:** `runReport`/`emit`/`deps`/`limits` shapes match across Tasks 1–2; `onCite(anchor)` + anchor shape `{section, specId?, paragraphId?}` match `audit.showAnchor`.
