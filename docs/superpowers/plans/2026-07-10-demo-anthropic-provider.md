# Demo Anthropic Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the demo's "Ask SpecR" chat (`/chat`) and Compose (`/report`) run against the Anthropic Messages API as an alternative to OpenAI, selected explicitly by `LLM_PROVIDER`.

**Architecture:** The demo's internal message/tool shape stays OpenAI chat-completions (what `report-bridge.mjs` and `runChat` speak). A new pure adapter (`llm-providers.mjs`) translates that shape to/from the Anthropic wire; a raw-fetch `callAnthropic()` in `server.mjs` mirrors `callOpenAI()`. `report-bridge.mjs` is not modified.

**Tech Stack:** Node 22 ESM (`.mjs`), zero new dependencies (raw `fetch`), `node --test` for tests.

**Spec:** `docs/superpowers/specs/2026-07-10-demo-anthropic-provider-design.md` · **Issue:** #444 · **Branch:** `feat/issue-444` (already created from `origin/main`; work on it, NEVER on main)

## Global Constraints

- All work under `examples/web_ui_demo/` — `src/` untouched, no ADR.
- No new npm dependencies; Anthropic is called with raw `fetch`.
- `LLM_PROVIDER` values: exactly `openai` (default) | `anthropic`; anything else exits the process at boot with code 1.
- Anthropic defaults: model `claude-opus-4-8`, base `https://api.anthropic.com` (note: NO `/v1` suffix — `callAnthropic` appends `/v1/messages`), `max_tokens` 16000, header `anthropic-version: 2023-06-01`, auth header `x-api-key`.
- The internal `__readOnly` flag and the `{type:'function'}` wrapper must NEVER appear on the Anthropic wire.
- API keys are read only by `server.mjs` and never sent to the browser (existing guarantee, both providers).
- Back-compat: with no `LLM_PROVIDER` set, behavior is byte-identical to today; existing demo tests must stay green.
- Demo files are outside ESLint/vitest (`pnpm lint` covers `src/` only); still follow house style: small functions, no input mutation, `.js`-style ESM imports with extensions.
- Tests run with `node --test <file>` from the repo root; they are NOT part of CI.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Translation adapter `llm-providers.mjs`

**Files:**
- Create: `examples/web_ui_demo/llm-providers.mjs`
- Test: `examples/web_ui_demo/llm-providers.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (Task 2 imports these from `./llm-providers.mjs`):
  - `toAnthropicTools(tools)` — array of internal OpenAI tools `{type:'function', function:{name, description, parameters}, __readOnly?}` → array of `{name, description, input_schema}`. `undefined`/empty in → `[]`.
  - `toAnthropicRequest(messages)` — OpenAI-shaped history → `{ system: string|undefined, messages: AnthropicMessage[] }`.
  - `fromAnthropicResponse(response)` — Anthropic Messages response → `{ choices: [{ message: { role:'assistant', content: string, tool_calls?: [{id, type:'function', function:{name, arguments}}] } }] }`. `tool_calls` key present ONLY when the response had `tool_use` blocks.

- [ ] **Step 1: Write the failing tests**

Create `examples/web_ui_demo/llm-providers.test.mjs`:

```js
// Unit tests for the OpenAI↔Anthropic translation adapter (issue #444).
// Pure functions — no network, no server. Run:
//   node --test examples/web_ui_demo/llm-providers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromAnthropicResponse,
  toAnthropicRequest,
  toAnthropicTools,
} from './llm-providers.mjs';

test('toAnthropicTools maps function tools to name/description/input_schema', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'coordination_report',
        description: 'E&O report',
        parameters: { type: 'object', properties: { projectId: { type: 'string' } } },
      },
      __readOnly: true,
    },
  ];
  assert.deepEqual(toAnthropicTools(tools), [
    {
      name: 'coordination_report',
      description: 'E&O report',
      input_schema: { type: 'object', properties: { projectId: { type: 'string' } } },
    },
  ]);
});

test('toAnthropicTools defaults a missing schema and tolerates undefined input', () => {
  assert.deepEqual(toAnthropicTools(undefined), []);
  const [tool] = toAnthropicTools([{ type: 'function', function: { name: 'x' } }]);
  assert.deepEqual(tool.input_schema, { type: 'object', properties: {} });
  assert.equal(tool.description, '');
});

test('toAnthropicRequest hoists the leading system message', () => {
  const { system, messages } = toAnthropicRequest([
    { role: 'system', content: 'You are the SpecR assistant.' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(system, 'You are the SpecR assistant.');
  assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
});

test('toAnthropicRequest maps assistant tool_calls to tool_use blocks', () => {
  const { messages } = toAnthropicRequest([
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'get_spec', arguments: '{"id":"s1"}' } }],
    },
  ]);
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'c1', name: 'get_spec', input: { id: 's1' } }],
  });
});

test('consecutive tool results merge into ONE user message of tool_result blocks', () => {
  const { messages } = toAnthropicRequest([
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', function: { name: 'a', arguments: '{}' } },
        { id: 'c2', function: { name: 'b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'result A' },
    { role: 'tool', tool_call_id: 'c2', content: 'result B' },
  ]);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'c1', content: 'result A' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'result B' },
    ],
  });
});

test('malformed tool_call arguments become an empty input', () => {
  const { messages } = toAnthropicRequest([
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{oops' } }],
    },
  ]);
  assert.deepEqual(messages[1].content[0].input, {});
});

test('consecutive plain user turns merge (Anthropic requires alternating roles)', () => {
  const { messages } = toAnthropicRequest([
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
  ]);
  assert.deepEqual(messages, [{ role: 'user', content: 'first\n\nsecond' }]);
});

test('assistant text + tool_calls produce a text block before tool_use', () => {
  const { messages } = toAnthropicRequest([
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: 'checking…',
      tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{}' } }],
    },
  ]);
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: 'checking…' },
    { type: 'tool_use', id: 'c1', name: 'a', input: {} },
  ]);
});

test('an empty assistant message (no text, no tool_calls) is dropped', () => {
  const { messages } = toAnthropicRequest([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'again' },
  ]);
  // dropping the empty assistant turn makes the two user turns adjacent → merged
  assert.deepEqual(messages, [{ role: 'user', content: 'q\n\nagain' }]);
});

test('fromAnthropicResponse: text-only reply has no tool_calls key', () => {
  const { choices } = fromAnthropicResponse({
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there' },
    ],
    stop_reason: 'end_turn',
  });
  assert.deepEqual(choices[0].message, { role: 'assistant', content: 'Hello there' });
  assert.ok(!('tool_calls' in choices[0].message));
});

test('fromAnthropicResponse: tool_use blocks become OpenAI tool_calls', () => {
  const { choices } = fromAnthropicResponse({
    content: [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'c9', name: 'get_spec', input: { id: 's1' } },
    ],
    stop_reason: 'tool_use',
  });
  const message = choices[0].message;
  assert.equal(message.content, 'Let me check.');
  assert.deepEqual(message.tool_calls, [
    { id: 'c9', type: 'function', function: { name: 'get_spec', arguments: '{"id":"s1"}' } },
  ]);
});

test('fromAnthropicResponse tolerates an empty/missing content array', () => {
  assert.deepEqual(fromAnthropicResponse({}).choices[0].message, {
    role: 'assistant',
    content: '',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test examples/web_ui_demo/llm-providers.test.mjs`
Expected: FAIL — `Cannot find module … llm-providers.mjs` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Write the implementation**

Create `examples/web_ui_demo/llm-providers.mjs`:

```js
// Pure translation between the demo's internal OpenAI chat-completions shapes
// and the Anthropic Messages API (POST /v1/messages). The demo's tool loops
// (server.mjs runChat, report-bridge.mjs runReport) speak OpenAI shapes
// end-to-end; when LLM_PROVIDER=anthropic, server.mjs translates at the wire
// with these functions. Everything here is I/O-free and unit-tested
// (llm-providers.test.mjs).

// One OpenAI function tool → one Anthropic tool. The internal __readOnly flag
// (and the {type:'function'} wrapper) never reach the wire — the same rule the
// OpenAI path enforces before hitting /chat/completions.
export function toAnthropicTools(tools) {
  return (tools || []).map(({ function: fn }) => ({
    name: fn.name,
    description: fn.description || '',
    input_schema:
      fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
  }));
}

function parseToolArguments(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {}; // mirrors execToolCall's tolerance for malformed model output
  }
}

// Assistant turn → Anthropic content blocks (text first, then tool_use).
// Returns null for a turn with nothing in it — Anthropic rejects empty
// assistant content, and an empty turn carries no information anyway.
function toAssistantBlocks(message) {
  const blocks = [];
  if (typeof message.content === 'string' && message.content !== '') {
    blocks.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls || []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name,
      input: parseToolArguments(call.function?.arguments),
    });
  }
  return blocks.length > 0 ? blocks : null;
}

// Fold one OpenAI role:'tool' message into the accumulator. All tool results
// answering the same assistant turn must land in ONE user message — the
// Messages API rejects them split across turns.
function appendToolResult(out, message) {
  const block = {
    type: 'tool_result',
    tool_use_id: message.tool_call_id,
    content: typeof message.content === 'string' ? message.content : '',
  };
  const prev = out[out.length - 1];
  if (prev?.role === 'user' && Array.isArray(prev.content)) {
    prev.content.push(block);
  } else {
    out.push({ role: 'user', content: [block] });
  }
}

// Fold a plain user turn into the accumulator. Consecutive user turns merge
// because the Messages API requires alternating user/assistant roles (the
// browser history can contain back-to-back user turns after a failed send).
function appendUserText(out, text) {
  const prev = out[out.length - 1];
  if (prev?.role === 'user') {
    if (Array.isArray(prev.content)) prev.content.push({ type: 'text', text });
    else prev.content = `${prev.content}\n\n${text}`;
    return;
  }
  out.push({ role: 'user', content: text });
}

// OpenAI-shaped history → { system, messages } for the Messages API. A leading
// system message becomes the top-level `system` parameter (both loops always
// put it first); anything unrecognized degrades to a user text turn.
export function toAnthropicRequest(messages) {
  let system;
  const out = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' && index === 0) {
      system = message.content;
    } else if (message.role === 'assistant') {
      const blocks = toAssistantBlocks(message);
      if (blocks) out.push({ role: 'assistant', content: blocks });
    } else if (message.role === 'tool') {
      appendToolResult(out, message);
    } else {
      appendUserText(out, typeof message.content === 'string' ? message.content : '');
    }
  }
  return { system, messages: out };
}

// Anthropic response → the OpenAI chat-completion envelope the loops expect.
// tool_calls is present only when the model actually asked for tools, so
// runChat's "no calls → final answer" exit works unchanged.
export function fromAnthropicResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const toolCalls = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    }));
  const message = { role: 'assistant', content: text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return { choices: [{ message }] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test examples/web_ui_demo/llm-providers.test.mjs`
Expected: PASS — 12 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/llm-providers.mjs examples/web_ui_demo/llm-providers.test.mjs
git commit -m "feat(demo): OpenAI↔Anthropic translation adapter for the LLM bridge

Pure functions translating the demo's internal chat-completions shapes to the
Anthropic Messages API: tools → input_schema, assistant tool_calls → tool_use
blocks, consecutive tool results folded into one user message, leading system
message hoisted. Refs #444.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `server.mjs` provider plumbing + `callAnthropic` (black-box TDD)

**Files:**
- Modify: `examples/web_ui_demo/server.mjs` (config ~lines 33–47, `runChat` ~353, `handleChat` ~398, `handleReport` ~458, boot log ~552)
- Test: `examples/web_ui_demo/server.anthropic.test.mjs` (create)

**Interfaces:**
- Consumes (from Task 1, `./llm-providers.mjs`): `toAnthropicTools(tools)`, `toAnthropicRequest(messages)`, `fromAnthropicResponse(response)` — exact signatures in Task 1.
- Produces:
  - Env contract: `LLM_PROVIDER` (`openai` default | `anthropic` | else exit 1), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-4-8`), `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`).
  - `PROVIDER` object `{ name, model, keyName, hasKey, makeCallModel }`; `makeCallModel()` returns a per-request `(messages, tools) => Promise<completion>`.
  - Response contract: `/chat` success `data` gains `provider` (string) next to `model`; `/report` `done` event gains `provider`; no-key replies say `` `${keyName} not configured on the demo server` `` with `code:'no-key'` (Task 3 UI relies on `body.error`/`evt.error`).

- [ ] **Step 1: Write the failing black-box test**

Create `examples/web_ui_demo/server.anthropic.test.mjs`:

```js
// Black-box integration test for the demo's Anthropic provider (issue #444).
// Spawns server.mjs as a child pointed at a mock Anthropic Messages endpoint
// and a mock SpecR MCP endpoint (one server plays both), then asserts /chat
// and /report end-to-end plus the wire-level translation contract. Run:
//   node --test examples/web_ui_demo/server.anthropic.test.mjs
// Not part of CI (examples/ is outside the vitest projects).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
  });
}

// One mock plays the SpecR MCP endpoint (POST /mcp), the Anthropic Messages
// endpoint (POST /v1/messages), and a tripwire for the OpenAI path (which must
// never be hit while LLM_PROVIDER=anthropic).
function startMock(captured) {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mcp') return res.end(JSON.stringify(mcpResponse(body, captured)));
    if (req.url === '/v1/messages') {
      captured.anthropicBodies.push(body);
      captured.anthropicHeaders.push({
        'x-api-key': req.headers['x-api-key'],
        'anthropic-version': req.headers['anthropic-version'],
      });
      return res.end(JSON.stringify(anthropicResponse(body, captured)));
    }
    if (req.url.endsWith('/chat/completions')) {
      captured.openaiRequests += 1;
      return res.end('{"choices":[]}');
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return server;
}

function mcpResponse(body, captured) {
  if (body.method === 'tools/call') captured.mcpToolCalls.push(body.params?.name);
  if (body.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        tools: [
          {
            name: 'coordination_report',
            description: 'E&O report',
            inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'create_project',
            description: 'writes',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: false },
          },
        ],
      },
    };
  }
  return {
    jsonrpc: '2.0',
    id: body.id,
    result: {
      content: [{ type: 'text', text: '{"findings":[]}' }],
      _meta: { 'specr/anchors': [{ section: '03 30 00', specId: 's1', paragraphId: 'p1' }] },
    },
  };
}

function anthropicResponse(body, captured) {
  // The forced final turn disables tools with tool_choice:'none' — answer text.
  if (body.tool_choice?.type === 'none') {
    return {
      content: [{ type: 'text', text: 'Final: 03 30 00 has no coordination findings.' }],
      stop_reason: 'end_turn',
    };
  }
  const usedTool = body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
  );
  if (usedTool && !captured.alwaysToolUse) {
    return {
      content: [{ type: 'text', text: '03 30 00 has no coordination findings.' }],
      stop_reason: 'end_turn',
    };
  }
  return {
    content: [
      {
        type: 'tool_use',
        id: `c${captured.anthropicBodies.length}`,
        name: 'coordination_report',
        input: { projectId: 'p' },
      },
    ],
    stop_reason: 'tool_use',
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function spawnDemo(mockPort, demoPort, extraEnv = {}) {
  return spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(demoPort),
      HOST: '127.0.0.1',
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
      // A resident OpenAI key must NOT hijack the explicit provider choice.
      OPENAI_API_KEY: 'unused-openai-key',
      SPECR_API_BASE: `http://127.0.0.1:${mockPort}`,
      ...extraEnv,
    },
    stdio: 'ignore',
  });
}

async function stopDemo(child, mock) {
  child.kill();
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  mock.close();
}

async function waitForPort(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/`);
      if (probe.status) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`demo server did not come up on ${port}`);
}

function freshCaptured() {
  return { anthropicBodies: [], anthropicHeaders: [], mcpToolCalls: [], openaiRequests: 0 };
}

test('POST /chat answers via Anthropic with translated tools on the wire', async (t) => {
  const captured = freshCaptured();
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 21;
  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'any coordination issues in the project?' }],
    }),
  });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.provider, 'anthropic');
  assert.equal(body.data.model, 'claude-opus-4-8');
  assert.match(body.data.reply, /coordination findings/);
  assert.deepEqual(body.data.toolCalls, [{ name: 'coordination_report', ok: true }]);

  // Wire contract: Anthropic tool shape, no OpenAI wrapper, no internal flag.
  const first = captured.anthropicBodies[0];
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    ['coordination_report', 'create_project']
  );
  for (const tool of first.tools) {
    assert.ok('input_schema' in tool, 'tools must carry input_schema');
    assert.ok(!('function' in tool), 'OpenAI wrapper must not reach Anthropic');
    assert.ok(!('__readOnly' in tool), '__readOnly must not reach Anthropic');
  }
  assert.equal(typeof first.system, 'string');
  assert.match(first.system, /SpecR/);
  assert.equal(typeof first.max_tokens, 'number');
  assert.equal(captured.anthropicHeaders[0]['x-api-key'], 'test-key');
  assert.equal(captured.anthropicHeaders[0]['anthropic-version'], '2023-06-01');
  assert.equal(captured.openaiRequests, 0, 'OpenAI endpoint must never be called');
});

test('POST /chat round cap forces a final turn with tools + tool_choice none', async (t) => {
  const captured = freshCaptured();
  captured.alwaysToolUse = true; // model asks for a tool every round
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 22;
  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'loop forever' }] }),
  });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.match(body.data.reply, /^Final:/);

  // History with tool blocks REQUIRES a tools param — the final turn must send
  // the remembered tool list and forbid new calls via tool_choice none.
  const finalBody = captured.anthropicBodies[captured.anthropicBodies.length - 1];
  assert.deepEqual(finalBody.tool_choice, { type: 'none' });
  assert.ok(finalBody.tools.length > 0, 'final turn must still define tools');
  for (const earlier of captured.anthropicBodies.slice(0, -1)) {
    assert.ok(!('tool_choice' in earlier), 'normal rounds let the model decide');
  }
});

test('POST /report streams grounded steps and a done event via Anthropic', async (t) => {
  const captured = freshCaptured();
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 23;
  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'coordination report for the active project' }),
  });
  assert.equal(res.status, 200);
  const events = (await res.text())
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));

  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'expected a done event');
  assert.equal(done.provider, 'anthropic');
  assert.equal(done.model, 'claude-opus-4-8');
  assert.match(done.reply, /coordination findings/);
  assert.deepEqual(done.citations, [{ section: '03 30 00', specId: 's1', paragraphId: 'p1' }]);
  assert.ok(
    events.some((e) => e.type === 'step' && e.tool === 'coordination_report' && e.status === 'done')
  );

  // Compose is read-only: the write tool must not be advertised to the model.
  assert.deepEqual(
    captured.anthropicBodies[0].tools.map((tool) => tool.name),
    ['coordination_report']
  );
});

test('missing ANTHROPIC_API_KEY degrades /chat with a provider-specific no-key reply', async (t) => {
  const captured = freshCaptured();
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 24;
  const child = spawnDemo(mockPort, demoPort, { ANTHROPIC_API_KEY: '' });
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.code, 'no-key');
  assert.match(body.error, /ANTHROPIC_API_KEY/);
  assert.equal(captured.anthropicBodies.length, 0);
});

test('an invalid LLM_PROVIDER exits at boot with code 1', async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(3000 + (process.pid % 500) + 25), LLM_PROVIDER: 'gemini' },
    stdio: 'ignore',
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test examples/web_ui_demo/server.anthropic.test.mjs`
Expected: FAIL — the invalid-provider test hangs-then-fails or exits 0 (no validation yet), and the /chat tests fail with `code:'no-key'` mentioning OPENAI_API_KEY (server ignores `LLM_PROVIDER` and the Anthropic env today). Any failure is acceptable red; note which.

- [ ] **Step 3: Implement in `server.mjs`**

**3a — import the adapter** (top of file, after the `runReport` import at line 8):

```js
import { fromAnthropicResponse, toAnthropicRequest, toAnthropicTools } from './llm-providers.mjs';
```

**3b — config block.** Replace lines 34–45 (the HOST comment through `const OPENAI_MODEL …`) so the region reads:

```js
// Bind address. Defaults to loopback so the demo stays private to this machine;
// set HOST=0.0.0.0 to reach it from other machines on your LAN. That also exposes
// the proxied SpecR API and the LLM-backed /chat endpoint, so only opt in on a
// network you trust.
const HOST = process.env.HOST || '127.0.0.1';
const API_BASE = process.env.SPECR_API_BASE || 'http://127.0.0.1:3000';

// LLM chat bridge config — the demo speaks to exactly ONE provider, chosen
// explicitly by LLM_PROVIDER (keys alone never switch it). Keys live ONLY here
// (server-side); the browser never sees them. A missing key for the selected
// provider ⇒ /chat and /report degrade to a clear "not configured" reply.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
if (LLM_PROVIDER !== 'openai' && LLM_PROVIDER !== 'anthropic') {
  console.error(
    `SpecR demo: invalid LLM_PROVIDER "${process.env.LLM_PROVIDER}" — use "openai" or "anthropic".`
  );
  process.exit(1);
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// No /v1 suffix here — callAnthropic appends /v1/messages.
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 16_000; // Messages API requires max_tokens; ample for concise replies
```

**3c — `callAnthropic` + provider table.** Insert immediately AFTER the closing brace of `callOpenAI` (currently line 331):

```js
// Anthropic Messages API call, symmetric to callOpenAI. Accepts and returns
// the demo's internal OpenAI chat-completions shapes; llm-providers.mjs
// translates at the wire. toolChoice is Anthropic-shaped ({type:'none'}) or
// undefined to let the model decide.
async function callAnthropic(openAiMessages, openAiTools, toolChoice) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const { system, messages } = toAnthropicRequest(openAiMessages);
    const body = { model: ANTHROPIC_MODEL, max_tokens: ANTHROPIC_MAX_TOKENS, messages };
    if (system) body.system = system;
    const tools = toAnthropicTools(openAiTools);
    if (tools.length > 0) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
    }
    return fromAnthropicResponse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

// Per-request callModel factory. The Anthropic wrapper remembers the last
// non-empty tool list: the loops signal "final answer, no more tools" by
// passing empty tools, but the Messages API rejects tool_use/tool_result
// history when the request defines no tools — so the wrapper re-sends the
// tools it saw and forbids new calls with tool_choice {type:'none'}.
function makeAnthropicCallModel() {
  let lastTools = [];
  return (messages, tools) => {
    if (tools && tools.length > 0) {
      lastTools = tools;
      return callAnthropic(messages, tools, undefined);
    }
    return callAnthropic(messages, lastTools, { type: 'none' });
  };
}

// The single active provider, resolved once at boot from LLM_PROVIDER.
const PROVIDERS = {
  openai: {
    name: 'openai',
    model: OPENAI_MODEL,
    keyName: 'OPENAI_API_KEY',
    hasKey: OPENAI_API_KEY !== '',
    makeCallModel: () => (messages, tools) => callOpenAI(messages, tools),
  },
  anthropic: {
    name: 'anthropic',
    model: ANTHROPIC_MODEL,
    keyName: 'ANTHROPIC_API_KEY',
    hasKey: ANTHROPIC_API_KEY !== '',
    makeCallModel: makeAnthropicCallModel,
  },
};
const PROVIDER = PROVIDERS[LLM_PROVIDER];
```

**3d — `runChat` takes the callModel.** Change its signature and both model calls:

```js
async function runChat(userMessages, callModel) {
```

…inside the loop: `const completion = await callModel(messages, tools);`
…final forced turn: `const finalMessage = (await callModel(messages, undefined)).choices?.[0]?.message;`

**3e — `handleChat`.** Replace the no-key guard (lines 399–406) with:

```js
  if (!PROVIDER.hasKey) {
    sendJson(res, 200, {
      success: false,
      code: 'no-key',
      error: `${PROVIDER.keyName} not configured on the demo server`,
    });
    return;
  }
```

and replace the success path (lines 429–431) with:

```js
  try {
    const { reply, toolCalls, focus } = await runChat(clean, PROVIDER.makeCallModel());
    sendJson(res, 200, {
      success: true,
      data: { reply, toolCalls, focus, provider: PROVIDER.name, model: PROVIDER.model },
    });
```

**3f — `handleReport`.** Replace its no-key guard (lines 465–472) with:

```js
  if (!PROVIDER.hasKey) {
    emit({
      type: 'error',
      code: 'no-key',
      error: `${PROVIDER.keyName} not configured on the demo server`,
    });
    res.end();
    return;
  }
```

replace the `deps` block (lines 500–504) with:

```js
      deps: {
        listTools: listOpenAiTools,
        callModel: PROVIDER.makeCallModel(),
        execTool: execToolCall,
      },
```

and the done emit (line 506) with:

```js
    emit({ type: 'done', ...result, provider: PROVIDER.name, model: PROVIDER.model });
```

**3g — boot log.** Replace the final `console.log` (lines 552–554) with:

```js
  console.log(
    `Chat bridge: ${
      PROVIDER.hasKey
        ? `enabled (${PROVIDER.name}, model ${PROVIDER.model})`
        : `disabled (set ${PROVIDER.keyName} in .env)`
    }`
  );
```

Also update the two stale comments: line 12–17 header comment "OpenAI key, model, ports" → "LLM provider key, model, ports", and line 41-region comment "the OpenAI settings" → "the LLM provider settings" (part of 3b block above).

- [ ] **Step 4: Run the anthropic test to verify it passes**

Run: `node --test examples/web_ui_demo/server.anthropic.test.mjs`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Regression — existing tests stay green (default provider path)**

Run: `node --test examples/web_ui_demo/server.report.test.mjs examples/web_ui_demo/server.vendor.test.mjs`
Expected: PASS, same counts as before this task (run them on a clean checkout first if unsure).

- [ ] **Step 6: Commit**

```bash
git add examples/web_ui_demo/server.mjs examples/web_ui_demo/server.anthropic.test.mjs
git commit -m "feat(demo): explicit LLM_PROVIDER + raw-fetch Anthropic Messages bridge

LLM_PROVIDER=openai|anthropic selects the single active provider at boot
(invalid value fails fast). callAnthropic mirrors callOpenAI; a per-request
callModel wrapper re-sends the remembered tool list with tool_choice none on
the forced final turn, since the Messages API rejects tool history without a
tools param. /chat and /report responses now carry provider + model. Refs #444.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Provider-neutral UI copy (`chat.js`, `compose.js`)

**Files:**
- Modify: `examples/web_ui_demo/js/chat.js:1-6` (header comment), `js/chat.js:124-128` (no-key message)
- Modify: `examples/web_ui_demo/js/compose.js:4` (comment), `js/compose.js:139-144` (no-key message)

**Interfaces:**
- Consumes: `/chat` JSON error contract `{success:false, code:'no-key', error}` and `/report` NDJSON `{type:'error', code:'no-key', error}` (Task 2 guarantees `error` names the exact env var).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Edit `js/chat.js`**

Replace (lines 124–128):

```js
        const code = body?.code;
        const message =
          code === 'no-key'
            ? 'Chat is not configured — set OPENAI_API_KEY on the demo server (server.mjs) to enable it.'
            : body?.error || `chat failed: ${res.status}`;
```

with:

```js
        const code = body?.code;
        const message =
          code === 'no-key'
            ? body?.error ||
              'Chat is not configured — set the selected provider key (OPENAI_API_KEY or ANTHROPIC_API_KEY) on the demo server.'
            : body?.error || `chat failed: ${res.status}`;
```

In the header comment (lines 1–6), change `an OpenAI-backed assistant` to `an LLM-backed assistant (OpenAI or Anthropic)` and `which owns the OPENAI_API_KEY, runs the` / `OpenAI tool-calling loop` to `which owns the provider key, runs the` / `tool-calling loop`.

- [ ] **Step 2: Edit `js/compose.js`**

Replace (lines 139–145):

```js
  function renderError(evt) {
    const message =
      evt.code === 'no-key'
        ? 'Compose is not configured — set OPENAI_API_KEY on the demo server (server.mjs) to enable it.'
        : evt.error || 'report failed';
    outputEl.appendChild(el('p', 'compose-error', message));
  }
```

with:

```js
  function renderError(evt) {
    const message =
      evt.code === 'no-key'
        ? evt.error ||
          'Compose is not configured — set the selected provider key (OPENAI_API_KEY or ANTHROPIC_API_KEY) on the demo server.'
        : evt.error || 'report failed';
    outputEl.appendChild(el('p', 'compose-error', message));
  }
```

In the line-4 comment, change `runs a READ-ONLY OpenAI tool-calling loop` to `runs a READ-ONLY LLM tool-calling loop (OpenAI or Anthropic)`.

- [ ] **Step 3: Verify no stale hardcoded copy remains**

Run: `grep -rn "set OPENAI_API_KEY" examples/web_ui_demo/js/`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add examples/web_ui_demo/js/chat.js examples/web_ui_demo/js/compose.js
git commit -m "feat(demo): provider-neutral not-configured copy in chat + compose

The browser now prefers the server's error message (which names the exact
missing key for the selected provider) over hardcoded OpenAI-only copy.
Refs #444.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `.env.example` + README documentation

**Files:**
- Modify: `examples/web_ui_demo/.env.example:12-26`
- Modify: `examples/web_ui_demo/README.md:30, 149-168, 187, 208`

**Interfaces:**
- Consumes: env contract from Task 2 (`LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` default `claude-opus-4-8`, `ANTHROPIC_BASE_URL` default `https://api.anthropic.com`, no `/v1` suffix).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Rewrite the `.env.example` LLM section**

Replace lines 12–26 (the `# --- OpenAI-backed features …` block through `OPENAI_BASE_URL=…`) with:

```ini
# --- LLM-backed features (Ask SpecR chat + Compose reporting) — optional ----
# The demo speaks to ONE provider, chosen explicitly here (keys alone never
# switch it): "openai" or "anthropic". Organizations holding a usage-based
# enterprise API key under a data-protection agreement with either provider
# can point the demo at whichever one their agreement covers. The selected
# provider's key is read ONLY by this server and never sent to the browser.
# Leave the key blank to run with chat + Compose disabled (each shows a clear
# "not configured" note).
LLM_PROVIDER=openai

# --- OpenAI (LLM_PROVIDER=openai) --------------------------------------------
OPENAI_API_KEY=

# Chat model — any OpenAI chat-completions / tool-calling model, e.g.
# gpt-4o-mini, gpt-4o, gpt-5.4. Defaults to gpt-4o-mini when unset.
OPENAI_MODEL=gpt-4o-mini

# OpenAI-compatible base URL — override to point at Azure OpenAI, OpenRouter, a
# local proxy, etc. Defaults to the public OpenAI API when unset.
OPENAI_BASE_URL=https://api.openai.com/v1

# --- Anthropic (LLM_PROVIDER=anthropic) ---------------------------------------
ANTHROPIC_API_KEY=

# Chat model — any Anthropic tool-calling model, e.g. claude-opus-4-8,
# claude-sonnet-4-6, claude-haiku-4-5. Defaults to claude-opus-4-8 when unset.
ANTHROPIC_MODEL=claude-opus-4-8

# Anthropic base URL — override for an enterprise gateway or proxy. Defaults to
# the public Anthropic API when unset. No /v1 suffix (the server appends
# /v1/messages).
ANTHROPIC_BASE_URL=https://api.anthropic.com
```

- [ ] **Step 2: Update the README**

Four edits:

1. Line 30 — change `` `OPENAI_API_KEY` / `OPENAI_MODEL`, `PORT`, and `SPECR_API_BASE` `` to `` `LLM_PROVIDER` plus the provider key/model (OpenAI or Anthropic), `PORT`, and `SPECR_API_BASE` ``.

2. Lines 154–165 — in "Ask SpecR", change `the OpenAI tool-calling loop` to `the LLM tool-calling loop (OpenAI or Anthropic, chosen by \`LLM_PROVIDER\`)`, change `Enable it by setting \`OPENAI_API_KEY\` in \`.env\` (this folder):` to `Enable it by setting the selected provider's key in \`.env\` (this folder):`, and replace the ini block with:

````markdown
```ini
# examples/web_ui_demo/.env — OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...                        # required — stays server-side, never sent to the browser
OPENAI_MODEL=gpt-5.4                         # optional (default gpt-4o-mini; any tool-calling model)
OPENAI_BASE_URL=https://api.openai.com/v1    # optional — point at an OpenAI-compatible server

# …or Anthropic
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...                 # required — stays server-side, never sent to the browser
ANTHROPIC_MODEL=claude-opus-4-8              # optional (default claude-opus-4-8; any tool-calling model)
ANTHROPIC_BASE_URL=https://api.anthropic.com # optional — enterprise gateway/proxy (no /v1 suffix)
```

Both providers support usage-based enterprise API keys under data-protection
agreements — point the demo at whichever provider your organization's agreement
covers to iterate the MCP tooling against proprietary specifications.
````

3. Line 187 — change `**read-only** OpenAI tool-calling loop` to `**read-only** LLM tool-calling loop`.

4. Line 208 — change `Compose uses the **same** \`OPENAI_API_KEY\` as Ask SpecR (above)` to `Compose uses the **same** provider key as Ask SpecR (above — \`OPENAI_API_KEY\` or \`ANTHROPIC_API_KEY\`, per \`LLM_PROVIDER\`)`.

- [ ] **Step 3: Full demo test sweep**

Run: `node --test examples/web_ui_demo/`
Expected: PASS — all demo test files (llm-providers, server.anthropic, server.report, server.vendor, compare-*, scoring, render-markdown, report-bridge, source-order, spec-removal, word-diff), 0 failures.

- [ ] **Step 4: Commit**

```bash
git add examples/web_ui_demo/.env.example examples/web_ui_demo/README.md
git commit -m "docs(demo): document LLM_PROVIDER + Anthropic configuration

Refs #444.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Push, draft PR, board

**Files:** none (git/GitHub only).

**Interfaces:**
- Consumes: all prior commits on `feat/issue-444`.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/issue-444
```

- [ ] **Step 2: Open a DRAFT PR** (never ready-for-review)

```bash
gh pr create --draft --title "feat(demo): Anthropic API key + model support for the demo LLM bridge" --body "$(cat <<'EOF'
## Why

Organizations hold **either** OpenAI **or** Anthropic usage-based API keys under enterprise data-protection agreements. The demo's LLM features (Ask SpecR chat + Compose grounded reporting) were OpenAI-only, blocking Anthropic-keyed orgs from iterating SpecR's MCP functionality against proprietary specifications. All external chat interfaces live in `examples/web_ui_demo` — `src/` is untouched (no ADR, per maintainer guidance for demo-only changes).

## What

- `LLM_PROVIDER=openai|anthropic` selects the single active provider explicitly (default `openai`, full back-compat; invalid value fails fast at boot).
- New raw-fetch `callAnthropic()` symmetric to `callOpenAI()`, plus a pure translation adapter (`llm-providers.mjs`) between the demo's internal OpenAI chat-completions shape and the Anthropic Messages API — `report-bridge.mjs` unchanged.
- Forced tools-disabled final turns re-send the remembered tool list with `tool_choice: {type:'none'}` (the Messages API rejects tool history without a `tools` param).
- `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` (default `claude-opus-4-8`) / `ANTHROPIC_BASE_URL`; the key stays server-side, never sent to the browser.
- `/chat` + `/report` responses carry `provider`; not-configured copy is provider-specific end-to-end.
- Docs: `.env.example` + README. Design spec: `docs/superpowers/specs/2026-07-10-demo-anthropic-provider-design.md`.

## Testing

- [ ] Unit tests pass (`node --test examples/web_ui_demo/llm-providers.test.mjs`)
- [ ] Black-box provider tests pass (`node --test examples/web_ui_demo/server.anthropic.test.mjs`)
- [ ] Existing demo tests stay green (`node --test examples/web_ui_demo/`)
- [ ] Manual verification: `LLM_PROVIDER=anthropic` + a real key → Ask SpecR chat and Compose answer with MCP-grounded results
- [ ] CI green

🤖 Co-authored by Claude Fable 5. Closes #444.
EOF
)"
```

- [ ] **Step 3: Move the board**

```bash
gh-project-move 444 "In review"
```

- [ ] **Step 4: Verify CI runs on the draft**

Run: `gh pr checks --watch` (drafts DO run CI in this repo; only CodeRabbit skips drafts).
Expected: all checks pass (demo tests aren't in CI, so this is lint/build/unit/integration on unchanged `src/` — should be trivially green).

---

## Self-review notes

- **Spec coverage:** provider selection + fail-fast (Task 2 · 3b), adapter incl. tool-result merge + system hoist (Task 1), `callAnthropic` + tools-disabled turn (Task 2 · 3c), response `provider` fields (3e/3f), UI copy (Task 3), `.env.example`/README (Task 4), tests incl. wire assertions + no-key + regression (Tasks 1–2, sweep in Task 4), no ADR (none written), draft PR + board (Task 5). Out-of-scope items (streaming, UI switcher, src/) have no tasks — correct.
- **Type consistency:** `toAnthropicRequest/toAnthropicTools/fromAnthropicResponse` names and shapes match between Task 1 tests, Task 1 implementation, and Task 2 imports/`callAnthropic`. `PROVIDER.{name,model,keyName,hasKey,makeCallModel}` used consistently across 3c–3g. `runChat(clean, PROVIDER.makeCallModel())` matches the new `runChat(userMessages, callModel)` signature.
- **Known ordering constraint:** in the mock's `anthropicResponse`, the `tool_choice:'none'` branch must be checked before `alwaysToolUse` — the plan's code does this; don't reorder.
