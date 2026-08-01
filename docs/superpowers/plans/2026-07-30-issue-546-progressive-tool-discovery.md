# Progressive Tool Discovery Implementation Plan (#546)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the demo's MCP chat by replacing the dump-all-131-tools approach with each provider's native progressive tool discovery, and render chat errors as readable messages instead of raw JSON.

**Architecture:** Both providers require provider-native items echoed back through the tool loop, so the demo's shared chat-completions IR (`llm-providers.mjs`) is deleted and replaced by two adapters behind a session interface that owns an opaque transcript. `/chat` and `/report` both consume that interface; `/report` defers only its read-only pool.

**Tech Stack:** Node 22 ESM, zero runtime dependencies, `node:test` + `node:assert/strict` for tests. No TypeScript in `examples/`.

## Global Constraints

- Scope is `examples/web_ui_demo/` plus one CI step in `.github/workflows/ci.yml`. **No `src/` changes** — the MCP contract gates and `openapi.yaml` must stay untouched.
- Branch `fix/issue-546`. Never commit to `main`.
- Demo code is plain ESM `.mjs`. Relative imports carry `.js`/`.mjs` extensions.
- Tests are `node --test`, colocated as `*.test.mjs`. Run: `node --test "examples/web_ui_demo/*.test.mjs"` and `node --test "examples/web_ui_demo/providers/*.test.mjs"`.
- No `innerHTML` anywhere in the error path — `createElement` + `textContent` only.
- Core tool sets, verbatim:
  - Chat: `list_projects`, `list_sections`, `search_library`, `get_spec`, `get_references`
  - Report: `list_projects`, `list_sections`, `search_library`
- Model defaults: `OPENAI_MODEL=gpt-5.6-luna`, `ANTHROPIC_MODEL=claude-sonnet-4-6`.
- OpenAI endpoint: `${OPENAI_BASE}/responses`. Anthropic unchanged: `${ANTHROPIC_BASE}/v1/messages`.
- Anthropic tool-search tool: `tool_search_tool_bm25_20251119`, name `tool_search_tool_bm25`.
- Both APIs require at least one non-deferred *provider* tool. Each adapter's own
  search tool (`tool_search` / bm25) satisfies that unconditionally, so an empty
  application-tool core is legal — the core set is a first-turn optimization.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Tool partition module

**Files:**
- Create: `examples/web_ui_demo/providers/tools.mjs`
- Test: `examples/web_ui_demo/providers/tools.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CHAT_CORE_TOOLS: string[]`, `REPORT_CORE_TOOLS: string[]`
  - `splitCoreAndDeferred(catalog, coreNames) → { core: McpTool[], deferred: McpTool[] }`
  - `McpTool` shape: `{ name: string, description: string, inputSchema: object, readOnly: boolean }`
  - Returns an empty `core` when tier gating removes every named core tool; the
    adapter's own non-deferred search tool keeps the request valid.

- [ ] **Step 1: Write the failing test**

```javascript
// examples/web_ui_demo/providers/tools.test.mjs
// Pure partition logic — no network. Run:
//   node --test examples/web_ui_demo/providers/tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_CORE_TOOLS, REPORT_CORE_TOOLS, splitCoreAndDeferred } from './tools.mjs';

const tool = (name, readOnly = true) => ({
  name,
  description: `${name} description`,
  inputSchema: { type: 'object', properties: {} },
  readOnly,
});

test('splitCoreAndDeferred puts named tools in core and everything else in deferred', () => {
  const catalog = [tool('list_projects'), tool('get_spec'), tool('submittal_register')];
  const { core, deferred } = splitCoreAndDeferred(catalog, ['list_projects', 'get_spec']);
  assert.deepEqual(
    core.map((t) => t.name),
    ['list_projects', 'get_spec']
  );
  assert.deepEqual(
    deferred.map((t) => t.name),
    ['submittal_register']
  );
});

test('splitCoreAndDeferred: a core name absent from the catalog produces no phantom entry', () => {
  // Tier gating (MCP_ALLOWED_TIERS) can remove a tool from tools/list entirely.
  const catalog = [tool('list_projects'), tool('submittal_register')];
  const { core, deferred } = splitCoreAndDeferred(catalog, ['list_projects', 'get_spec']);
  assert.deepEqual(
    core.map((t) => t.name),
    ['list_projects']
  );
  assert.equal(core.length, 1);
  assert.deepEqual(
    deferred.map((t) => t.name),
    ['submittal_register']
  );
});

test('splitCoreAndDeferred throws when no core tool survives — both APIs reject all-deferred', () => {
  const catalog = [tool('submittal_register')];
  assert.throws(() => splitCoreAndDeferred(catalog, ['list_projects']), /at least one non-deferred/i);
});

test('splitCoreAndDeferred preserves catalog order within each partition', () => {
  const catalog = [tool('a'), tool('list_projects'), tool('b'), tool('get_spec')];
  const { core, deferred } = splitCoreAndDeferred(catalog, ['get_spec', 'list_projects']);
  assert.deepEqual(
    core.map((t) => t.name),
    ['list_projects', 'get_spec']
  );
  assert.deepEqual(
    deferred.map((t) => t.name),
    ['a', 'b']
  );
});

test('the chat core set is the five agreed tools', () => {
  assert.deepEqual(CHAT_CORE_TOOLS, [
    'list_projects',
    'list_sections',
    'search_library',
    'get_spec',
    'get_references',
  ]);
});

test('the report core set is the three discovery tools its prompt names first', () => {
  assert.deepEqual(REPORT_CORE_TOOLS, ['list_projects', 'list_sections', 'search_library']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/providers/tools.test.mjs`
Expected: FAIL — `Cannot find module './tools.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// examples/web_ui_demo/providers/tools.mjs
// Partitions the MCP catalog into an always-loaded core set and a deferred
// remainder. Both providers' tool search loads deferred definitions on demand;
// both reject a request where every tool is deferred, so the core set is a
// protocol requirement rather than an optimization.
//
// Core slots cost context on every request and buy a fast, reliable FIRST turn.
// They do not affect capability — deferred tools stay reachable via search.

// Chat: the five tools a spec-editor question most often opens with.
// get_references is here because the chat greeting advertises
// "which sections cite 09 22 00?" (index.html) as an example question.
export const CHAT_CORE_TOOLS = [
  'list_projects',
  'list_sections',
  'search_library',
  'get_spec',
  'get_references',
];

// Report: exactly the discovery tools REPORT_SYSTEM_PROMPT instructs the model
// to call first ("discover ids first with list_projects, list_sections, or
// search_library").
export const REPORT_CORE_TOOLS = ['list_projects', 'list_sections', 'search_library'];

export function splitCoreAndDeferred(catalog, coreNames) {
  const wanted = new Set(coreNames);
  const core = [];
  const deferred = [];
  for (const tool of catalog) {
    if (wanted.has(tool.name)) core.push(tool);
    else deferred.push(tool);
  }
  // A core tool can be absent from the catalog entirely when MCP_ALLOWED_TIERS
  // gates it away. Partitioning over what tools/list actually returned means a
  // gated tool simply doesn't appear — never a phantom entry the API would reject.
  if (core.length === 0) {
    throw new Error(
      'tool partition produced an empty core set — at least one non-deferred tool is required'
    );
  }
  return { core, deferred };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/providers/tools.test.mjs`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/providers/tools.mjs examples/web_ui_demo/providers/tools.test.mjs
git commit -m "feat(demo): add core/deferred tool partition for progressive discovery

Both providers' tool search needs the catalog split into an always-loaded
core set and a deferred remainder, and both reject an all-deferred request.
Partitioning over what tools/list actually returned means a tier-gated core
tool is simply absent rather than a phantom entry the API would reject.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Provider error normalization

**Files:**
- Create: `examples/web_ui_demo/providers/errors.mjs`
- Test: `examples/web_ui_demo/providers/errors.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class ProviderError extends Error` with fields `code: string|null`, `status: number|null`, `detail: string`
  - `normalizeProviderError(provider, status, bodyText) → ProviderError`

- [ ] **Step 1: Write the failing test**

```javascript
// examples/web_ui_demo/providers/errors.test.mjs
// Turns a provider's error body into a clean message + code + separate detail.
// The bug this fixes: the raw JSON body used to be concatenated into
// err.message and rendered verbatim in the chat bubble. Run:
//   node --test examples/web_ui_demo/providers/errors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, normalizeProviderError } from './errors.mjs';

test('normalizeProviderError extracts the OpenAI message and code, keeping raw body separate', () => {
  const body = JSON.stringify({
    error: {
      message: "Invalid 'tools': array too long.",
      type: 'invalid_request_error',
      code: 'array_above_max_length',
    },
  });
  const err = normalizeProviderError('openai', 400, body);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.message, "Invalid 'tools': array too long.");
  assert.equal(err.code, 'array_above_max_length');
  assert.equal(err.status, 400);
  assert.equal(err.detail, body);
  // The regression: the raw JSON must NOT be inside the message.
  assert.ok(!err.message.includes('{'));
});

test('normalizeProviderError extracts the Anthropic message shape', () => {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'max_tokens is required' },
  });
  const err = normalizeProviderError('anthropic', 400, body);
  assert.equal(err.message, 'max_tokens is required');
  assert.equal(err.code, 'invalid_request_error');
  assert.equal(err.status, 400);
});

test('normalizeProviderError falls back to trimmed raw text for a non-JSON body', () => {
  const err = normalizeProviderError('openai', 502, '<html>Bad Gateway</html>');
  assert.equal(err.status, 502);
  assert.equal(err.code, null);
  assert.ok(err.message.includes('502'));
  assert.equal(err.detail, '<html>Bad Gateway</html>');
});

test('normalizeProviderError handles an empty body without throwing', () => {
  const err = normalizeProviderError('anthropic', 500, '');
  assert.equal(err.status, 500);
  assert.ok(err.message.length > 0);
  assert.equal(err.detail, '');
});

test('normalizeProviderError adds a model-floor hint when the model rejects tool search', () => {
  const body = JSON.stringify({
    error: { message: "Unknown parameter: 'tools[0].type' = tool_search.", code: 'unknown_parameter' },
  });
  const err = normalizeProviderError('openai', 400, body);
  assert.match(err.message, /gpt-5\.4 or newer/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/providers/errors.test.mjs`
Expected: FAIL — `Cannot find module './errors.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// examples/web_ui_demo/providers/errors.mjs
// One typed error for every provider failure. The clean sentence, the provider's
// code, and the raw body are kept as SEPARATE fields — never concatenated. The
// UI shows the sentence and hides the detail behind a disclosure.

export class ProviderError extends Error {
  constructor(message, { code = null, status = null, detail = '', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// Tool search needs a model floor on both platforms (gpt-5.4+ / Opus 4.5+). The
// providers report that as a generic unknown-parameter error, which tells a demo
// user nothing actionable — so we translate it.
function hintFor(provider, message) {
  if (!/tool_search|defer_loading/i.test(message)) return null;
  return provider === 'openai'
    ? 'This demo needs an OpenAI model of gpt-5.4 or newer (set OPENAI_MODEL).'
    : 'This demo needs a Claude model of Sonnet 4.5 / Opus 4.5 or newer (set ANTHROPIC_MODEL).';
}

export function normalizeProviderError(provider, status, bodyText) {
  const detail = typeof bodyText === 'string' ? bodyText : '';
  let message = '';
  let code = null;
  try {
    const parsed = JSON.parse(detail);
    // OpenAI and Anthropic both nest the human-readable text at error.message.
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
    if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
    else if (typeof parsed?.error?.type === 'string') code = parsed.error.type;
  } catch {
    // Non-JSON body (gateway HTML, empty response) — fall through to the generic
    // message below and keep the raw text as detail.
  }
  if (message === '') message = `${provider} request failed with HTTP ${status}.`;
  const hint = hintFor(provider, message);
  if (hint) message = `${message} ${hint}`;
  return new ProviderError(message, { code, status, detail });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/providers/errors.test.mjs`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/providers/errors.mjs examples/web_ui_demo/providers/errors.test.mjs
git commit -m "feat(demo): normalize provider errors into message, code and detail

The raw provider body used to be concatenated into err.message and
rendered verbatim in the chat bubble. Keeping the sentence, the code and
the raw body as separate fields lets the UI show one readable line and
hide the rest behind a disclosure.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: OpenAI Responses adapter

**Files:**
- Create: `examples/web_ui_demo/providers/openai.mjs`
- Test: `examples/web_ui_demo/providers/openai.test.mjs`

**Interfaces:**
- Consumes: `splitCoreAndDeferred` (Task 1), `normalizeProviderError`/`ProviderError` (Task 2).
- Produces: `createOpenAiSession({ system, userMessages, catalog, coreToolNames, config, fetchImpl }) → session` where
  - `session.send() → Promise<{ text: string, toolCalls: [{ id, name, args }], usage: { inputTokens, outputTokens } }>`
  - `session.addToolResults(results)` — `results: [{ id, text }]`
  - `session.finalize() → Promise<{ text, usage }>`
  - `config`: `{ model, apiKey, baseUrl, timeoutMs }`

- [ ] **Step 1: Write the failing test**

```javascript
// examples/web_ui_demo/providers/openai.test.mjs
// Wire-shape tests for the Responses API adapter. fetch is injected, so no
// network. Run: node --test examples/web_ui_demo/providers/openai.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiSession } from './openai.mjs';
import { ProviderError } from './errors.mjs';

const CONFIG = { model: 'gpt-5.6-luna', apiKey: 'sk-test', baseUrl: 'https://api.test/v1', timeoutMs: 1000 };

const catalog = [
  { name: 'list_projects', description: 'List projects', inputSchema: { type: 'object' }, readOnly: true },
  { name: 'submittal_register', description: 'Build a submittal register', inputSchema: { type: 'object' }, readOnly: true },
];

// Records each request body and replies with the queued responses in order.
function stubFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body),
      json: async () => next.body,
    };
  };
  impl.calls = calls;
  return impl;
}

const textResponse = (text) => ({
  body: {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});

test('send posts to /responses with tool_search, a non-deferred core tool, and deferred remainder', async () => {
  const fetchImpl = stubFetch([textResponse('hello')]);
  const session = createOpenAiSession({
    system: 'SYS',
    userMessages: [{ role: 'user', content: 'hi' }],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  await session.send();

  const { url, body } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.test/v1/responses');
  assert.equal(body.model, 'gpt-5.6-luna');
  assert.equal(body.instructions, 'SYS');
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);

  // tool_search must be present, or deferred tools are unreachable.
  assert.ok(body.tools.some((t) => t.type === 'tool_search'));
  const core = body.tools.find((t) => t.name === 'list_projects');
  const deferred = body.tools.find((t) => t.name === 'submittal_register');
  // Responses uses FLAT function tools — no nested `function` wrapper.
  assert.equal(core.type, 'function');
  assert.equal(core.defer_loading, undefined);
  assert.equal(deferred.defer_loading, true);
});

test('send returns assistant text and parses function_call items into toolCalls', async () => {
  const fetchImpl = stubFetch([
    {
      body: {
        output: [
          { type: 'reasoning', encrypted_content: 'ENC' },
          { type: 'function_call', call_id: 'call_1', name: 'list_projects', arguments: '{"limit":5}' },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
  ]);
  const session = createOpenAiSession({
    system: 'SYS',
    userMessages: [{ role: 'user', content: 'hi' }],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  const result = await session.send();
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'list_projects', args: { limit: 5 } }]);
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2 });
});

test('the second request echoes every prior output item, including encrypted reasoning', async () => {
  const fetchImpl = stubFetch([
    {
      body: {
        output: [
          { type: 'reasoning', encrypted_content: 'ENC' },
          { type: 'function_call', call_id: 'call_1', name: 'list_projects', arguments: '{}' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    textResponse('done'),
  ]);
  const session = createOpenAiSession({
    system: 'SYS',
    userMessages: [{ role: 'user', content: 'hi' }],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  await session.send();
  session.addToolResults([{ id: 'call_1', text: 'RESULT' }]);
  await session.send();

  const second = fetchImpl.calls[1].body.input;
  assert.ok(second.some((i) => i.type === 'reasoning' && i.encrypted_content === 'ENC'));
  assert.ok(second.some((i) => i.type === 'function_call' && i.call_id === 'call_1'));
  const output = second.find((i) => i.type === 'function_call_output');
  assert.equal(output.call_id, 'call_1');
  assert.equal(output.output, 'RESULT');
});

test('finalize suppresses further tool calls with tool_choice none', async () => {
  const fetchImpl = stubFetch([textResponse('final answer')]);
  const session = createOpenAiSession({
    system: 'SYS',
    userMessages: [{ role: 'user', content: 'hi' }],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  const result = await session.finalize();
  assert.equal(result.text, 'final answer');
  assert.equal(fetchImpl.calls[0].body.tool_choice, 'none');
  // Tools must still be DECLARED — a transcript containing tool calls with no
  // tools declared is rejected.
  assert.ok(fetchImpl.calls[0].body.tools.length > 0);
});

test('a non-ok response raises a ProviderError with a clean message and separate detail', async () => {
  const fetchImpl = stubFetch([
    { ok: false, status: 400, body: { error: { message: 'bad tools', code: 'invalid_request' } } },
  ]);
  const session = createOpenAiSession({
    system: 'SYS',
    userMessages: [{ role: 'user', content: 'hi' }],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  await assert.rejects(() => session.send(), (err) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.message, 'bad tools');
    assert.equal(err.status, 400);
    assert.ok(err.detail.includes('bad tools'));
    return true;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/providers/openai.test.mjs`
Expected: FAIL — `Cannot find module './openai.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// examples/web_ui_demo/providers/openai.mjs
// OpenAI Responses API adapter. Owns its transcript as an opaque array of
// Response Items; runChat/runReport never see this shape.
//
// Progressive discovery is native: {type:'tool_search'} plus defer_loading on
// every non-core tool. All definitions are still SENT each request — the API
// keeps deferred ones out of the model's context until it searches for them.
import { splitCoreAndDeferred } from './tools.mjs';
import { normalizeProviderError } from './errors.mjs';

// Responses uses flat, internally-tagged function tools — no nested wrapper.
function toFunctionTool(tool) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function buildTools(catalog, coreToolNames) {
  const { core, deferred } = splitCoreAndDeferred(catalog, coreToolNames);
  return [
    { type: 'tool_search' },
    ...core.map(toFunctionTool),
    ...deferred.map((tool) => ({ ...toFunctionTool(tool), defer_loading: true })),
  ];
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {}; // tolerate malformed model output rather than failing the turn
  }
}

function readText(output) {
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('');
}

function readToolCalls(output) {
  return output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      id: item.call_id,
      name: item.name,
      args: parseArguments(item.arguments),
    }));
}

export function createOpenAiSession({ system, userMessages, catalog, coreToolNames, config, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const tools = buildTools(catalog, coreToolNames);
  // The running transcript: seeded with the user turns, then grown with every
  // output item the API returns plus our tool results.
  const input = userMessages.map((m) => ({
    type: 'message',
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  async function post(extra) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await doFetch(`${config.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          instructions: system,
          input,
          tools,
          // The demo persists nothing server-side; encrypted reasoning rides in
          // the transcript instead.
          store: false,
          include: ['reasoning.encrypted_content'],
          ...extra,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw normalizeProviderError('openai', res.status, await res.text().catch(() => ''));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function absorb(response) {
    const output = Array.isArray(response.output) ? response.output : [];
    // Echo every item back verbatim next round — reasoning included, or the
    // model loses its chain of thought across the tool boundary.
    input.push(...output);
    return {
      text: readText(output),
      toolCalls: readToolCalls(output),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  return {
    async send() {
      return absorb(await post({}));
    },
    addToolResults(results) {
      for (const { id, text } of results) {
        input.push({ type: 'function_call_output', call_id: id, output: text });
      }
    },
    async finalize() {
      // Tools stay DECLARED — only new calls are suppressed. A transcript with
      // tool calls but no declared tools is rejected.
      const { text, usage } = absorb(await post({ tool_choice: 'none' }));
      return { text, usage };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/providers/openai.test.mjs`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/providers/openai.mjs examples/web_ui_demo/providers/openai.test.mjs
git commit -m "feat(demo): add OpenAI Responses adapter with native tool search

Replaces the Chat Completions call with a Responses session that owns its
own transcript. Deferred tool definitions are still sent on every request;
the API keeps them out of the model's context until it searches, which is
what lets a 131-tool catalog work at all.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Anthropic Messages adapter

**Files:**
- Create: `examples/web_ui_demo/providers/anthropic.mjs`
- Test: `examples/web_ui_demo/providers/anthropic.test.mjs`

**Interfaces:**
- Consumes: `splitCoreAndDeferred` (Task 1), `normalizeProviderError` (Task 2).
- Produces: `createAnthropicSession({ system, userMessages, catalog, coreToolNames, config, fetchImpl }) → session` — identical surface to Task 3. `config`: `{ model, apiKey, baseUrl, version, maxTokens, timeoutMs }`.

- [ ] **Step 1: Write the failing test**

```javascript
// examples/web_ui_demo/providers/anthropic.test.mjs
// Wire-shape tests for the Messages API adapter. Run:
//   node --test examples/web_ui_demo/providers/anthropic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicSession } from './anthropic.mjs';

const CONFIG = {
  model: 'claude-sonnet-4-6',
  apiKey: 'sk-ant-test',
  baseUrl: 'https://api.anthropic.test',
  version: '2023-06-01',
  maxTokens: 16000,
  timeoutMs: 1000,
};

const catalog = [
  { name: 'list_projects', description: 'List projects', inputSchema: { type: 'object' }, readOnly: true },
  { name: 'submittal_register', description: 'Build a submittal register', inputSchema: { type: 'object' }, readOnly: true },
];

function stubFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body),
      json: async () => next.body,
    };
  };
  impl.calls = calls;
  return impl;
}

const textResponse = (text) => ({
  body: { content: [{ type: 'text', text }], usage: { input_tokens: 3, output_tokens: 4 } },
});

const newSession = (fetchImpl) =>
  createAnthropicSession({
    system: 'SYS',
    userMessages: [{ role: 'user', content: 'hi' }],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });

test('send posts to /v1/messages with the bm25 search tool and deferred remainder', async () => {
  const fetchImpl = stubFetch([textResponse('hello')]);
  await newSession(fetchImpl).send();

  const { url, body } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.anthropic.test/v1/messages');
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.system, 'SYS');
  assert.ok(body.tools.some((t) => t.type === 'tool_search_tool_bm25_20251119'));

  const core = body.tools.find((t) => t.name === 'list_projects');
  const deferred = body.tools.find((t) => t.name === 'submittal_register');
  assert.ok(core.input_schema, 'Messages API uses input_schema, not parameters');
  assert.equal(core.defer_loading, undefined);
  assert.equal(deferred.defer_loading, true);
});

test('send parses tool_use blocks into toolCalls', async () => {
  const fetchImpl = stubFetch([
    {
      body: {
        content: [
          { type: 'text', text: 'looking' },
          { type: 'tool_use', id: 'toolu_1', name: 'list_projects', input: { limit: 5 } },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
  ]);
  const result = await newSession(fetchImpl).send();
  assert.equal(result.text, 'looking');
  assert.deepEqual(result.toolCalls, [{ id: 'toolu_1', name: 'list_projects', args: { limit: 5 } }]);
});

test('server_tool_use and tool_search_tool_result blocks are echoed back verbatim', async () => {
  const searchBlocks = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'submittals' } },
    {
      type: 'tool_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'submittal_register' }] },
    },
    { type: 'tool_use', id: 'toolu_9', name: 'submittal_register', input: {} },
  ];
  const fetchImpl = stubFetch([
    { body: { content: searchBlocks, usage: { input_tokens: 1, output_tokens: 1 } } },
    textResponse('done'),
  ]);
  const session = newSession(fetchImpl);
  const first = await session.send();

  // The search call is provider-side: it must NOT surface as an executable call.
  assert.deepEqual(
    first.toolCalls.map((c) => c.id),
    ['toolu_9']
  );

  session.addToolResults([{ id: 'toolu_9', text: 'REGISTER' }]);
  await session.send();

  const messages = fetchImpl.calls[1].body.messages;
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.deepEqual(assistant.content, searchBlocks, 'search blocks must survive unchanged');

  // Returning a tool_result for a srvtoolu_ id is rejected by the API.
  const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
  assert.deepEqual(
    results.map((r) => r.tool_use_id),
    ['toolu_9']
  );
});

test('all tool results for one turn land in a single user message', async () => {
  const fetchImpl = stubFetch([
    {
      body: {
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'list_projects', input: {} },
          { type: 'tool_use', id: 'toolu_b', name: 'submittal_register', input: {} },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    textResponse('done'),
  ]);
  const session = newSession(fetchImpl);
  await session.send();
  session.addToolResults([
    { id: 'toolu_a', text: 'A' },
    { id: 'toolu_b', text: 'B' },
  ]);
  await session.send();

  const userTurns = fetchImpl.calls[1].body.messages.filter((m) => m.role === 'user' && Array.isArray(m.content));
  assert.equal(userTurns.length, 1, 'the API rejects tool results split across turns');
  assert.equal(userTurns[0].content.length, 2);
});

test('a history starting on an assistant turn has that turn dropped (#457 regression)', async () => {
  // chat.js sends history.slice(-CONTEXT_WINDOW), which can cut the transcript
  // so it opens on an assistant reply. The Messages API requires the first
  // message to be a user turn. PR #457 fixed this in the module this adapter
  // replaces — the guard must survive the migration.
  const fetchImpl = stubFetch([textResponse('ok')]);
  const session = createAnthropicSession({
    system: 'SYS',
    userMessages: [
      { role: 'assistant', content: 'earlier reply' },
      { role: 'user', content: 'real question' },
    ],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  await session.send();
  const { messages } = fetchImpl.calls[0].body;
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'real question');
});

test('consecutive user turns merge — the API requires alternating roles (#457)', async () => {
  const fetchImpl = stubFetch([textResponse('ok')]);
  const session = createAnthropicSession({
    system: 'SYS',
    userMessages: [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  await session.send();
  const { messages } = fetchImpl.calls[0].body;
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /first[\s\S]*second/);
});

test('finalize keeps tools declared and suppresses new calls', async () => {
  const fetchImpl = stubFetch([textResponse('final')]);
  const result = await newSession(fetchImpl).finalize();
  assert.equal(result.text, 'final');
  assert.deepEqual(fetchImpl.calls[0].body.tool_choice, { type: 'none' });
  assert.ok(fetchImpl.calls[0].body.tools.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/providers/anthropic.test.mjs`
Expected: FAIL — `Cannot find module './anthropic.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// examples/web_ui_demo/providers/anthropic.mjs
// Anthropic Messages API adapter. Symmetric to the OpenAI one: it owns an
// opaque transcript of Messages-API content blocks.
//
// Tool search runs SERVER-side here. The server_tool_use and
// tool_search_tool_result blocks it produces must be echoed back unchanged, and
// a tool_result must never be returned for a srvtoolu_ id — the API rejects it.
import { splitCoreAndDeferred } from './tools.mjs';
import { normalizeProviderError } from './errors.mjs';

const SEARCH_TOOL = { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' };

function toAnthropicTool(tool) {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

function buildTools(catalog, coreToolNames) {
  const { core, deferred } = splitCoreAndDeferred(catalog, coreToolNames);
  return [
    SEARCH_TOOL,
    ...core.map(toAnthropicTool),
    ...deferred.map((tool) => ({ ...toAnthropicTool(tool), defer_loading: true })),
  ];
}

// The Messages API requires alternating roles starting on a user turn. The
// browser sends a fixed-size slice of its transcript (chat.js history.slice), so
// the history can open on an assistant reply or carry back-to-back user turns
// after a failed send. Normalizing here preserves the fix from PR #457, which
// lived in the module this adapter replaces.
function normalizeHistory(userMessages) {
  const out = [];
  for (const message of userMessages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = out[out.length - 1];
    if (role === 'user' && previous?.role === 'user') {
      previous.content = `${previous.content}\n\n${message.content}`;
      continue;
    }
    out.push({ role, content: message.content });
  }
  while (out.length > 0 && out[0].role === 'assistant') out.shift();
  return out;
}

export function createAnthropicSession({ system, userMessages, catalog, coreToolNames, config, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const tools = buildTools(catalog, coreToolNames);
  const messages = normalizeHistory(userMessages);

  async function post(extra) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await doFetch(`${config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': config.version,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          system,
          messages,
          tools,
          ...extra,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw normalizeProviderError('anthropic', res.status, await res.text().catch(() => ''));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function absorb(response) {
    const blocks = Array.isArray(response.content) ? response.content : [];
    // Echo the assistant turn verbatim — server_tool_use and
    // tool_search_tool_result included, or discovered tools are lost.
    if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      // Only client-executable tool_use blocks. server_tool_use is Anthropic's
      // own search call and is never ours to run.
      toolCalls: blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  return {
    async send() {
      return absorb(await post({}));
    },
    addToolResults(results) {
      // Every result answering one assistant turn must land in ONE user message.
      const content = results.map(({ id, text }) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: text,
      }));
      if (content.length > 0) messages.push({ role: 'user', content });
    },
    async finalize() {
      const { text, usage } = absorb(await post({ tool_choice: { type: 'none' } }));
      return { text, usage };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/providers/anthropic.test.mjs`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/providers/anthropic.mjs examples/web_ui_demo/providers/anthropic.test.mjs
git commit -m "feat(demo): add Anthropic Messages adapter with native tool search

Tool search runs server-side on this platform, so the server_tool_use and
tool_search_tool_result blocks have to survive the round trip untouched
and must never be answered with a tool_result — the API rejects that.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Adapter selection and configuration

**Files:**
- Create: `examples/web_ui_demo/providers/index.mjs`
- Modify: `examples/web_ui_demo/server.mjs:46-68` (provider config block)
- Modify: `examples/web_ui_demo/.env.example`
- Modify: `examples/web_ui_demo/README.md`

**Interfaces:**
- Consumes: `createOpenAiSession` (Task 3), `createAnthropicSession` (Task 4).
- Produces: `createSession({ provider, system, userMessages, catalog, coreToolNames, config, fetchImpl }) → session` — dispatches on `provider` (`'openai' | 'anthropic'`), throws on anything else.

- [ ] **Step 1: Write the failing test**

```javascript
// examples/web_ui_demo/providers/index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './index.mjs';

const base = {
  system: 'SYS',
  userMessages: [{ role: 'user', content: 'hi' }],
  catalog: [{ name: 'list_projects', description: 'd', inputSchema: { type: 'object' }, readOnly: true }],
  coreToolNames: ['list_projects'],
  config: { model: 'm', apiKey: 'k', baseUrl: 'https://x', version: '2023-06-01', maxTokens: 10, timeoutMs: 10 },
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }),
};

test('createSession returns a session exposing the shared interface for openai', () => {
  const session = createSession({ ...base, provider: 'openai' });
  assert.equal(typeof session.send, 'function');
  assert.equal(typeof session.addToolResults, 'function');
  assert.equal(typeof session.finalize, 'function');
});

test('createSession returns a session exposing the shared interface for anthropic', () => {
  const session = createSession({ ...base, provider: 'anthropic' });
  assert.equal(typeof session.send, 'function');
  assert.equal(typeof session.addToolResults, 'function');
  assert.equal(typeof session.finalize, 'function');
});

test('createSession rejects an unknown provider', () => {
  assert.throws(() => createSession({ ...base, provider: 'gemini' }), /unknown provider/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/providers/index.test.mjs`
Expected: FAIL — `Cannot find module './index.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// examples/web_ui_demo/providers/index.mjs
// Single entry point for the chat/report loops. Both surfaces build a session
// and then speak only send / addToolResults / finalize — never a provider shape.
import { createOpenAiSession } from './openai.mjs';
import { createAnthropicSession } from './anthropic.mjs';

export { CHAT_CORE_TOOLS, REPORT_CORE_TOOLS } from './tools.mjs';
export { ProviderError } from './errors.mjs';

export function createSession({ provider, ...rest }) {
  if (provider === 'openai') return createOpenAiSession(rest);
  if (provider === 'anthropic') return createAnthropicSession(rest);
  throw new Error(`unknown provider "${provider}" — use "openai" or "anthropic"`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/providers/index.test.mjs`
Expected: PASS — 3 tests

- [ ] **Step 5: Update the model defaults in `server.mjs`**

In the config block (around line 55 and 64), change the two defaults:

```javascript
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
// ...
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
```

Add a comment above `OPENAI_MODEL` recording the floor:

```javascript
// Tool search (progressive tool discovery) requires the Responses API and a
// gpt-5.4+ model; the demo's 131-tool MCP catalog does not fit without it.
// gpt-5.6-luna is the cheapest tier clearing that floor.
```

- [ ] **Step 6: Update `.env.example` and `README.md`**

In `.env.example`, update the model lines and note the floor:

```bash
# Tool search requires gpt-5.4 or newer (Responses API).
OPENAI_MODEL=gpt-5.6-luna
# Tool search requires Sonnet 4.5 / Opus 4.5 or newer.
ANTHROPIC_MODEL=claude-sonnet-4-6
```

In `README.md`, find the LLM configuration section and add one sentence: the demo
exposes SpecR's full MCP catalog through native tool search, so the selected model
must support it — `gpt-5.4+` on OpenAI, Sonnet 4.5 / Opus 4.5+ on Anthropic.

- [ ] **Step 7: Verify nothing regressed**

Run: `node --test "examples/web_ui_demo/providers/*.test.mjs"`
Expected: PASS — 19 tests across four files

- [ ] **Step 8: Commit**

```bash
git add examples/web_ui_demo/providers/index.mjs examples/web_ui_demo/providers/index.test.mjs \
        examples/web_ui_demo/server.mjs examples/web_ui_demo/.env.example examples/web_ui_demo/README.md
git commit -m "feat(demo): add provider selection and raise the model floor

Tool search needs the Responses API on OpenAI and a recent Claude on
Anthropic, so the defaults move to gpt-5.6-luna and claude-sonnet-4-6 —
the cheapest tiers clearing each floor. No boot-time model validation: a
regex guessing model families would break on the next release, and the
provider already reports the mismatch precisely.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Rewire `/chat` onto the session interface

**Files:**
- Modify: `examples/web_ui_demo/server.mjs` (`toOpenAiTool`, `listOpenAiTools`, `callOpenAI`, `callAnthropic`, `makeAnthropicCallModel`, `PROVIDERS`, `runChat`, `handleChat`)
- Delete: `examples/web_ui_demo/llm-providers.mjs`, `examples/web_ui_demo/llm-providers.test.mjs`, `examples/web_ui_demo/server.anthropic.test.mjs`
- Test: `examples/web_ui_demo/chat-loop.test.mjs` (create)

**Interfaces:**
- Consumes: `createSession`, `CHAT_CORE_TOOLS`, `ProviderError` (Task 5).
- Produces:
  - `listMcpTools() → Promise<McpTool[]>` replacing `listOpenAiTools`; maps `annotations.readOnlyHint` to `readOnly`.
  - `runChat({ session, execTool, maxRounds }) → { reply, toolCalls, focus }` — exported from the new `chat-loop.mjs`. Return shape is unchanged from the old `runChat`, so `chat.js`'s success path needs no edit.
  - `dedupeAnchors(anchors) → anchors[]` — moves out of `server.mjs` into `chat-loop.mjs`.
  - `CHAT_MAX_TOOL_ROUNDS = 8` (was 6).

- [ ] **Step 1: Write the failing test**

```javascript
// examples/web_ui_demo/chat-loop.test.mjs
// The provider-agnostic chat loop: it must speak ONLY send/addToolResults/
// finalize. Run: node --test examples/web_ui_demo/chat-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from './chat-loop.mjs';

// A fake session honouring the shared interface.
function fakeSession(turns) {
  const added = [];
  return {
    added,
    async send() {
      return turns.shift();
    },
    addToolResults(results) {
      added.push(...results);
    },
    async finalize() {
      return { text: 'forced final', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

const execTool = async (call) => ({ text: `ran ${call.name}`, ok: true, anchors: [] });

test('runChat returns the model text when no tools are called', async () => {
  const session = fakeSession([{ text: 'hello', toolCalls: [], usage: {} }]);
  const result = await runChat({ session, execTool, maxRounds: 8 });
  assert.equal(result.reply, 'hello');
  assert.deepEqual(result.toolCalls, []);
});

test('runChat executes tool calls and feeds results back before answering', async () => {
  const session = fakeSession([
    { text: '', toolCalls: [{ id: 'c1', name: 'get_spec', args: {} }], usage: {} },
    { text: 'answered', toolCalls: [], usage: {} },
  ]);
  const result = await runChat({ session, execTool, maxRounds: 8 });
  assert.equal(result.reply, 'answered');
  assert.deepEqual(session.added, [{ id: 'c1', text: 'ran get_spec' }]);
  assert.deepEqual(result.toolCalls, [{ name: 'get_spec', ok: true }]);
});

test('runChat forces a final answer once the round cap is reached', async () => {
  const turns = Array.from({ length: 8 }, () => ({
    text: '',
    toolCalls: [{ id: 'c', name: 'get_spec', args: {} }],
    usage: {},
  }));
  const result = await runChat({ session: fakeSession(turns), execTool, maxRounds: 8 });
  assert.equal(result.reply, 'forced final');
});

test('runChat surfaces the last successful anchors as focus', async () => {
  const session = fakeSession([
    { text: '', toolCalls: [{ id: 'c1', name: 'search_library', args: {} }], usage: {} },
    { text: 'done', toolCalls: [], usage: {} },
  ]);
  const withAnchors = async () => ({ text: 'x', ok: true, anchors: [{ section: '09 22 00' }] });
  const result = await runChat({ session, execTool: withAnchors, maxRounds: 8 });
  assert.deepEqual(result.focus.anchors, [{ section: '09 22 00' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/chat-loop.test.mjs`
Expected: FAIL — `Cannot find module './chat-loop.mjs'`

- [ ] **Step 3: Extract the loop into `chat-loop.mjs`**

```javascript
// examples/web_ui_demo/chat-loop.mjs
// The provider-agnostic chat loop. It speaks only the session interface, so it
// works identically on OpenAI and Anthropic and is unit-testable with a fake.

// Collapse duplicate navigation anchors and cap the payload so a broad answer
// cannot flood the UI.
export function dedupeAnchors(anchors) {
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    if (!a || typeof a.section !== 'string' || a.section === '') continue;
    const key = `${a.section}|${a.specId ?? ''}|${a.paragraphId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= 50) break;
  }
  return out;
}

export async function runChat({ session, execTool, maxRounds }) {
  const toolCalls = [];
  let focusAnchors = [];

  for (let round = 0; round < maxRounds; round++) {
    const { text, toolCalls: calls } = await session.send();
    if (!calls || calls.length === 0) {
      return { reply: text || '', toolCalls, focus: { anchors: dedupeAnchors(focusAnchors) } };
    }
    const results = [];
    for (const call of calls) {
      const { text: resultText, ok, anchors } = await execTool(call);
      toolCalls.push({ name: call.name, ok });
      if (ok && anchors.length > 0) focusAnchors = anchors; // last enriched answer wins
      results.push({ id: call.id, text: resultText });
    }
    session.addToolResults(results);
  }

  // Round cap reached — force a closing answer with new tool calls suppressed.
  const final = await session.finalize();
  return {
    reply: final.text || 'Reached the tool-call limit.',
    toolCalls,
    focus: { anchors: dedupeAnchors(focusAnchors) },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/chat-loop.test.mjs`
Expected: PASS — 4 tests

- [ ] **Step 5: Rewire `server.mjs`**

Replace `toOpenAiTool` / `listOpenAiTools` with a raw MCP mapper:

```javascript
// Shape one MCP tool for the adapters. inputSchema is already JSON Schema on the
// wire. readOnly carries the server's readOnlyHint so /report can restrict its
// catalog to tools that cannot mutate state.
function toMcpTool(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema:
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

async function listMcpTools() {
  const result = await mcpRpc('tools/list', {});
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools.map(toMcpTool);
}
```

Delete `callOpenAI`, `callAnthropic`, `makeAnthropicCallModel`, the
`dedupeAnchors` copy (now imported from `chat-loop.mjs`), and the
`llm-providers.mjs` import. Reduce `PROVIDERS` to configuration only:

```javascript
const PROVIDERS = {
  openai: {
    name: 'openai',
    model: OPENAI_MODEL,
    keyName: 'OPENAI_API_KEY',
    hasKey: OPENAI_API_KEY !== '',
    config: { model: OPENAI_MODEL, apiKey: OPENAI_API_KEY, baseUrl: OPENAI_BASE, timeoutMs: 60_000 },
  },
  anthropic: {
    name: 'anthropic',
    model: ANTHROPIC_MODEL,
    keyName: 'ANTHROPIC_API_KEY',
    hasKey: ANTHROPIC_API_KEY !== '',
    config: {
      model: ANTHROPIC_MODEL,
      apiKey: ANTHROPIC_API_KEY,
      baseUrl: ANTHROPIC_BASE,
      version: ANTHROPIC_VERSION,
      maxTokens: ANTHROPIC_MAX_TOKENS,
      timeoutMs: 60_000,
    },
  },
};
```

Raise the round cap and extend the system prompt with the tool-category line both
vendors recommend for discoverability:

```javascript
const CHAT_MAX_TOOL_ROUNDS = 8; // +2 over the pre-discovery cap: a search can cost a round
```

Append to `SYSTEM_PROMPT`:

```javascript
  'Most tools are discovered on demand — search for them by capability. Categories:',
  'projects, specs and paragraphs, packages and issued revisions, headers/footers,',
  'language rules, coordination and reporting, templates and numbering profiles.',
```

Rewrite `handleChat`'s success path to build a session:

```javascript
  try {
    const catalog = await listMcpTools();
    const session = createSession({
      provider: PROVIDER.name,
      system: SYSTEM_PROMPT,
      userMessages: clean,
      catalog,
      coreToolNames: CHAT_CORE_TOOLS,
      config: PROVIDER.config,
    });
    const { reply, toolCalls, focus } = await runChat({
      session,
      execTool: execToolCall,
      maxRounds: CHAT_MAX_TOOL_ROUNDS,
    });
    sendJson(res, 200, {
      success: true,
      data: { reply, toolCalls, focus, provider: PROVIDER.name, model: PROVIDER.model },
    });
  } catch (err) {
    sendJson(res, 502, {
      success: false,
      code: err.code ?? null,
      error: err.message,
      detail: err.detail ?? '',
    });
  }
```

Update `execToolCall` to take the session-shaped call (`call.name`, `call.args`)
rather than the OpenAI shape:

```javascript
async function execToolCall(call) {
  try {
    const result = await mcpRpc('tools/call', { name: call.name, arguments: call.args });
    const text =
      (result?.content || [])
        .map((part) => part.text)
        .filter(Boolean)
        .join('\n') || '(no content)';
    const raw = result?._meta?.['specr/anchors'];
    return { text: text.slice(0, 8000), ok: result?.isError !== true, anchors: Array.isArray(raw) ? raw : [] };
  } catch (err) {
    return { text: `tool error: ${err.message}`, ok: false, anchors: [] };
  }
}
```

- [ ] **Step 6: Delete the retired modules**

```bash
git rm examples/web_ui_demo/llm-providers.mjs \
       examples/web_ui_demo/llm-providers.test.mjs \
       examples/web_ui_demo/server.anthropic.test.mjs
```

- [ ] **Step 7: Run the full demo suite**

Run: `node --test "examples/web_ui_demo/*.test.mjs" "examples/web_ui_demo/providers/*.test.mjs"`
Expected: PASS. `/report` is still broken at this point (Task 7 fixes it) — if
`report-bridge.test.mjs` fails here, that is expected and Task 7 resolves it. Do
not "fix" it by reverting the IR.

- [ ] **Step 8: Commit**

```bash
git add -A examples/web_ui_demo/
git commit -m "refactor(demo): run /chat on the provider-agnostic session interface

The chat loop no longer touches provider shapes: it sends, executes tools
against MCP, and feeds results back. That is all it ever needed, and it is
what lets both providers' native tool search work behind one code path.

Deletes llm-providers.mjs — the chat-completions IR cannot represent the
provider-native items both APIs now require echoed through the loop.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Migrate `/report` onto the session interface

**Files:**
- Modify: `examples/web_ui_demo/report-bridge.mjs` (`REPORT_SYSTEM_PROMPT`, `filterReadOnlyTools`, `estimateTokens`, `runReport`)
- Modify: `examples/web_ui_demo/server.mjs` (`handleReport` deps block, ~line 586-600)
- Modify: `examples/web_ui_demo/report-bridge.test.mjs`

**Interfaces:**
- Consumes: `createSession`, `REPORT_CORE_TOOLS` (Task 5); `runReport` keeps its `{ request, scope, deps, limits, emit }` signature so `server.mjs`'s streaming contract is unchanged.
- Produces: `filterReadOnlyTools(tools)` now filters on `tool.readOnly === true` (was `tool.__readOnly`). `runReport` deps become `{ createSession, listTools, execTool }`.

- [ ] **Step 1: Write the failing test**

```javascript
// Add to examples/web_ui_demo/report-bridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterReadOnlyTools, runReport } from './report-bridge.mjs';

test('filterReadOnlyTools keeps only readOnly tools — the write tools never reach the agent', () => {
  const tools = [
    { name: 'get_spec', readOnly: true },
    { name: 'update_paragraph', readOnly: false },
    { name: 'delete_project', readOnly: false },
  ];
  assert.deepEqual(
    filterReadOnlyTools(tools).map((t) => t.name),
    ['get_spec']
  );
});

test('runReport builds its session over the READ-ONLY pool only', async () => {
  // The security invariant: if write tools were deferred rather than excluded,
  // the model could DISCOVER and call one via tool search.
  let seenCatalog = null;
  const deps = {
    listTools: async () => [
      { name: 'get_spec', description: 'd', inputSchema: {}, readOnly: true },
      { name: 'list_projects', description: 'd', inputSchema: {}, readOnly: true },
      { name: 'update_paragraph', description: 'd', inputSchema: {}, readOnly: false },
    ],
    createSession: ({ catalog }) => {
      seenCatalog = catalog;
      return {
        async send() {
          return { text: 'report body', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
        addToolResults() {},
        async finalize() {
          return { text: 'final', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
    },
    execTool: async () => ({ text: 'x', ok: true, anchors: [] }),
  };
  await runReport({
    request: 'compare things',
    scope: {},
    deps,
    limits: { maxRounds: 4, maxToolCalls: 4, tokenBudget: 100000 },
    emit: () => {},
  });
  assert.deepEqual(
    seenCatalog.map((t) => t.name),
    ['get_spec', 'list_projects'],
    'update_paragraph must be absent entirely, not merely deferred'
  );
});

test('runReport enforces the execution-time allow-list as defence in depth', async () => {
  const emitted = [];
  const deps = {
    listTools: async () => [{ name: 'get_spec', description: 'd', inputSchema: {}, readOnly: true }],
    createSession: () => {
      const turns = [
        { text: '', toolCalls: [{ id: 'c1', name: 'delete_project', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
        { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
      ];
      return {
        async send() {
          return turns.shift();
        },
        addToolResults() {},
        async finalize() {
          return { text: 'final', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
    },
    execTool: async () => {
      throw new Error('execTool must never run for a disallowed tool');
    },
  };
  await runReport({
    request: 'r',
    scope: {},
    deps,
    limits: { maxRounds: 4, maxToolCalls: 4, tokenBudget: 100000 },
    emit: (e) => emitted.push(e),
  });
  assert.ok(emitted.some((e) => e.type === 'step' && /not permitted/i.test(e.detail ?? '')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/report-bridge.test.mjs`
Expected: FAIL — `filterReadOnlyTools` still reads `__readOnly`, and `runReport` still calls `deps.callModel`.

- [ ] **Step 3: Rewrite the report loop**

First add the import at the top of `report-bridge.mjs`:

```javascript
import { REPORT_CORE_TOOLS } from './providers/tools.mjs';
```

Existing tests in `report-bridge.test.mjs` cover `buildReportMessages` and
`estimateTokens`, both of which are being replaced. Update those tests to target
`buildReportInput` and the real-usage accounting rather than deleting their
coverage — the scope-label concatenation they pin is still behaviour worth
holding.

Then change the filter to the new field:

```javascript
// Keep only tools the MCP server flagged read-only (annotations.readOnlyHint).
// This is the demo's structural answer to the "human-in-the-loop for writes"
// footgun. With progressive discovery this matters MORE, not less: a deferred
// write tool would still be discoverable by search, so write tools must be
// excluded from the catalog entirely rather than merely deferred.
export function filterReadOnlyTools(tools) {
  return tools.filter((tool) => tool && tool.readOnly === true);
}
```

Replace the `runReport` loop body:

```javascript
export async function runReport({ request, scope, deps, limits, emit }) {
  // Read-only pool ONLY — see filterReadOnlyTools. Everything here is a
  // candidate for discovery, so anything that could mutate state must be gone.
  const catalog = filterReadOnlyTools(await deps.listTools());
  const allowed = new Set(catalog.map((tool) => tool.name));
  const { userContent } = buildReportInput(request, scope);
  const session = deps.createSession({
    system: REPORT_SYSTEM_PROMPT,
    userMessages: [{ role: 'user', content: userContent }],
    catalog,
    coreToolNames: REPORT_CORE_TOOLS,
  });

  const ctx = { emit, toolCalls: [], anchors: [], stepNo: 0, allowed, tokens: 0 };
  let roundsUsed = 0;

  for (let round = 1; round <= limits.maxRounds; round++) {
    roundsUsed = round;
    const { text, toolCalls: calls, usage } = await session.send();
    ctx.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    if (!calls || calls.length === 0) return finish(text || '', ctx, round);

    const results = [];
    for (const call of calls) results.push(await processCall(call, ctx, limits, deps));
    session.addToolResults(results);
    emit({ type: 'usage', ...usageOf(ctx, round) });
    if (overBudget(ctx, limits)) break;
  }

  const final = await session.finalize();
  return finish(final.text || 'Reached the report scope limit.', ctx, roundsUsed);
}
```

Update `processCall` to honour the allow-list and return a session-shaped result:

```javascript
async function processCall(call, ctx, limits, deps) {
  ctx.stepNo += 1;
  if (!ctx.allowed.has(call.name)) {
    // Defence in depth: the catalog already excludes write tools, but a model
    // can still emit a name it was never given.
    ctx.emit({ type: 'step', n: ctx.stepNo, detail: `${call.name} is not permitted in a report` });
    ctx.toolCalls.push({ name: call.name, ok: false });
    return { id: call.id, text: `tool error: ${call.name} is not permitted in a report` };
  }
  ctx.emit({ type: 'step', n: ctx.stepNo, detail: humanizeToolStep(call.name, call.args) });
  const { text, ok, anchors } = await deps.execTool(call);
  ctx.toolCalls.push({ name: call.name, ok });
  if (ok && anchors.length > 0) ctx.anchors.push(...anchors);
  return { id: call.id, text: clampToolText(text) };
}
```

Replace `estimateTokens`/`overBudget`/`usageOf` with real usage:

```javascript
// Real provider usage replaces the old ≈4-chars/token estimate: adapter
// transcripts are opaque, and the reported numbers are more accurate anyway.
function overBudget(ctx, limits) {
  return ctx.toolCalls.length >= limits.maxToolCalls || ctx.tokens > limits.tokenBudget;
}

function usageOf(ctx, round) {
  return { rounds: round, toolCalls: ctx.toolCalls.length, tokens: ctx.tokens };
}
```

Replace `buildReportMessages` with `buildReportInput` (the system prompt is now a
session parameter, not a message):

```javascript
export function buildReportInput(request, scope) {
  const label = scope && typeof scope.label === 'string' ? scope.label.trim() : '';
  return { userContent: label ? `${request}\n\nScope in this workspace — ${label}` : request };
}
```

Add the discovery note to `REPORT_SYSTEM_PROMPT`, right after the workflow line:

```javascript
  'Most tools are not preloaded — search for them by capability, then call them.',
```

- [ ] **Step 4: Rewire `handleReport` in `server.mjs`**

```javascript
      deps: {
        listTools: listMcpTools,
        createSession: (opts) => createSession({ ...opts, provider: PROVIDER.name, config: PROVIDER.config }),
        execTool: execToolCall,
      },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test "examples/web_ui_demo/*.test.mjs" "examples/web_ui_demo/providers/*.test.mjs"`
Expected: PASS — the full demo suite, including the three new report tests.

- [ ] **Step 6: Commit**

```bash
git add -A examples/web_ui_demo/
git commit -m "refactor(demo): run /report on the session interface with tool search

/report shared the callModel and tool listing the chat migration deletes,
so it moves to the same interface. Its catalog is the read-only pool only:
under progressive discovery a deferred write tool would still be
discoverable by search, so write tools must be absent rather than deferred.

Token accounting switches from the ~4-chars/token estimate to real usage
reported by each provider, since adapter transcripts are opaque.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Readable chat errors

**Files:**
- Create: `examples/web_ui_demo/js/chat-error-view.mjs`
- Modify: `examples/web_ui_demo/js/chat.js:120-145`
- Modify: `examples/web_ui_demo/css/app.css` (after `.chat-bubble.is-pending`, ~line 3503)
- Test: `examples/web_ui_demo/chat-error-view.test.mjs` (create)

**Interfaces:**
- Consumes: the `/chat` failure envelope from Task 6 — `{ success: false, code, error, detail }`.
- Produces: `buildErrorBubble(doc, { error, code, detail }) → element` exported from **`js/chat-error-view.mjs`**.

> **Why its own module:** `js/chat.js` imports `./render-markdown.mjs` at load
> time, so importing `chat.js` from a `node --test` file would execute
> browser-targeted code with no DOM present. Keeping the builder in a
> dependency-free module makes it importable under Node without a DOM shim for
> the whole chat module.

- [ ] **Step 1: Write the failing test**

```javascript
// examples/web_ui_demo/chat-error-view.test.mjs
// The error bubble is built with createElement + textContent only — no
// innerHTML anywhere in the error path. Run:
//   node --test examples/web_ui_demo/chat-error-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorBubble } from './js/chat-error-view.mjs';

// Minimal DOM stub: enough for createElement/appendChild/textContent.
function fakeDocument() {
  const make = (tag) => ({
    tag,
    className: '',
    textContent: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  });
  return { createElement: make };
}

const flatten = (node) => [node, ...node.children.flatMap(flatten)];

test('buildErrorBubble shows the clean message and never the raw JSON inline', () => {
  const bubble = buildErrorBubble(fakeDocument(), {
    error: "Invalid 'tools': array too long.",
    code: 'array_above_max_length',
    detail: '{"error":{"message":"Invalid \'tools\': array too long."}}',
  });
  const texts = flatten(bubble).map((n) => n.textContent);
  assert.ok(texts.includes("Invalid 'tools': array too long."));
  // The raw body must not be the bubble's primary text.
  const primary = flatten(bubble).find((n) => n.className.includes('chat-text'));
  assert.ok(!primary.textContent.includes('{'));
});

test('buildErrorBubble puts the raw detail behind a details/summary disclosure', () => {
  const bubble = buildErrorBubble(fakeDocument(), {
    error: 'bad',
    code: 'x',
    detail: 'RAW BODY HERE',
  });
  const nodes = flatten(bubble);
  assert.ok(nodes.some((n) => n.tag === 'details'));
  assert.ok(nodes.some((n) => n.tag === 'summary'));
  assert.ok(nodes.some((n) => n.textContent === 'RAW BODY HERE'));
});

test('buildErrorBubble omits the disclosure entirely when there is no detail', () => {
  const bubble = buildErrorBubble(fakeDocument(), { error: 'no key configured', code: 'no-key', detail: '' });
  assert.ok(!flatten(bubble).some((n) => n.tag === 'details'));
});

test('buildErrorBubble marks the bubble as an error for styling', () => {
  const bubble = buildErrorBubble(fakeDocument(), { error: 'bad', code: null, detail: '' });
  assert.match(bubble.className, /is-error/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/chat-error-view.test.mjs`
Expected: FAIL — `Cannot find module './js/chat-error-view.mjs'`

- [ ] **Step 3: Create `js/chat-error-view.mjs`**

```javascript
// examples/web_ui_demo/js/chat-error-view.mjs
// Error bubbles are built here so they can be unit-tested without a browser.
// Everything is createElement + textContent: an error string may contain a raw
// provider body, which must never be parsed as markup.
export function buildErrorBubble(doc, { error, code, detail }) {
  const bubble = doc.createElement('div');
  bubble.className = 'chat-bubble is-assistant is-error';

  const role = doc.createElement('span');
  role.className = 'chat-role';
  role.textContent = 'SpecR';
  bubble.appendChild(role);

  const body = doc.createElement('p');
  body.className = 'chat-text';
  body.textContent = error;
  bubble.appendChild(body);

  // Technical detail stays one click away rather than front-loaded — the same
  // progressive disclosure the rest of the UI uses for OOXML internals.
  if (detail) {
    const details = doc.createElement('details');
    details.className = 'chat-error-detail';
    const summary = doc.createElement('summary');
    summary.textContent = code ? `Technical detail (${code})` : 'Technical detail';
    details.appendChild(summary);
    const pre = doc.createElement('pre');
    pre.textContent = detail;
    details.appendChild(pre);
    bubble.appendChild(details);
  }
  return bubble;
}
```

Then import it at the top of `js/chat.js`:

```javascript
import { buildErrorBubble } from './chat-error-view.mjs';
```

Replace the failure branch in `send()`:

```javascript
      if (!body || body.success !== true) {
        const message =
          body?.code === 'no-key'
            ? body?.error ||
              'Chat is not configured — set the selected provider key (OPENAI_API_KEY or ANTHROPIC_API_KEY) on the demo server.'
            : body?.error || `The chat service returned HTTP ${res.status}.`;
        const bubble = buildErrorBubble(document, {
          error: message,
          code: body?.code ?? null,
          detail: body?.detail ?? '',
        });
        list.appendChild(bubble);
        scrollToEnd();
        return;
      }
```

And the network-failure branch:

```javascript
    } catch (err) {
      pending.remove();
      const bubble = buildErrorBubble(document, {
        error: 'Could not reach the chat service. Is the demo server running?',
        code: null,
        detail: err.message,
      });
      list.appendChild(bubble);
      scrollToEnd();
    } finally {
```

- [ ] **Step 4: Add the styles**

In `css/app.css`, after the `.chat-bubble.is-pending` rule:

```css
.chat-bubble.is-error {
  border-left: 3px solid var(--danger, #c0392b);
}

.chat-error-detail {
  margin-top: 0.5rem;
  font-size: 0.85em;
}

.chat-error-detail summary {
  cursor: pointer;
  opacity: 0.75;
}

.chat-error-detail pre {
  margin: 0.4rem 0 0;
  padding: 0.5rem;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--surface-sunken, rgba(0, 0, 0, 0.06));
  border-radius: 4px;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/chat-error-view.test.mjs`
Expected: PASS — 4 tests

- [ ] **Step 6: Commit**

```bash
git add examples/web_ui_demo/js/chat.js examples/web_ui_demo/css/app.css \
        examples/web_ui_demo/js/chat-error-view.mjs \
        examples/web_ui_demo/chat-error-view.test.mjs
git commit -m "fix(demo): render chat failures as readable errors, not raw JSON

A failed turn used to print the provider's response body verbatim in the
message bubble. The clean sentence is now the bubble text and the raw body
sits behind a disclosure — the same progressive disclosure the rest of the
UI uses for technical detail.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Regression test and CI gate

**Files:**
- Create: `examples/web_ui_demo/providers/catalog-regression.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `splitCoreAndDeferred` (Task 1), `createOpenAiSession` (Task 3).
- Produces: nothing.

- [ ] **Step 1: Write the regression test**

```javascript
// examples/web_ui_demo/providers/catalog-regression.test.mjs
// Regression for #546, named for the symptom.
// The demo used to hand OpenAI every tool the MCP server exposed; at 131 tools
// that exceeded the 128 cap and every chat turn failed. Run:
//   node --test examples/web_ui_demo/providers/catalog-regression.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_CORE_TOOLS, splitCoreAndDeferred } from './tools.mjs';
import { createOpenAiSession } from './openai.mjs';

// A catalog the size of SpecR's real read+write surface.
function bigCatalog(size) {
  const names = [...CHAT_CORE_TOOLS];
  for (let i = names.length; i < size; i++) names.push(`tool_${i}`);
  return names.map((name) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  }));
}

test('chat: 131-tool catalog is deferred, not sent as 131 live tools', async () => {
  const catalog = bigCatalog(131);
  const { core, deferred } = splitCoreAndDeferred(catalog, CHAT_CORE_TOOLS);
  assert.equal(core.length, 5);
  assert.equal(deferred.length, 126);

  let sent = null;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ output: [], usage: {} }), text: async () => '{}' };
  };
  const session = createOpenAiSession({
    system: 'SYS',
    userMessages: [{ role: 'user', content: 'show me the submittals section' }],
    catalog,
    coreToolNames: CHAT_CORE_TOOLS,
    config: { model: 'gpt-5.6-luna', apiKey: 'k', baseUrl: 'https://x/v1', timeoutMs: 1000 },
    fetchImpl,
  });
  await session.send();

  // Only the core set plus the search tool are live; everything else is deferred
  // and therefore absent from the model's context.
  const live = sent.tools.filter((t) => t.type === 'function' && t.defer_loading !== true);
  assert.equal(live.length, 5);
  assert.equal(sent.tools.filter((t) => t.defer_loading === true).length, 126);
  assert.ok(sent.tools.some((t) => t.type === 'tool_search'));
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/providers/catalog-regression.test.mjs`
Expected: PASS — 1 test

- [ ] **Step 3: Add the CI gate**

In `.github/workflows/ci.yml`, add a step to the existing test job, after the unit
test step:

```yaml
      - name: Demo unit tests
        run: node --test "examples/web_ui_demo/*.test.mjs" "examples/web_ui_demo/providers/*.test.mjs"
```

- [ ] **Step 4: Verify the whole suite passes as CI will run it**

Run: `node --test "examples/web_ui_demo/*.test.mjs" "examples/web_ui_demo/providers/*.test.mjs"`
Expected: PASS — all demo tests (306 pre-existing plus the new ones), 0 failures

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/providers/catalog-regression.test.mjs .github/workflows/ci.yml
git commit -m "test(demo): pin the #546 symptom and gate demo tests in CI

CI ran none of the demo's 306 passing tests, which is why a completely
dead chat sidebar shipped. Gating them makes the regression test — and
every other demo test — actually enforceable.

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Live verification and PR

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-issue-546-progressive-tool-discovery-design.md` (Risks section)

**Interfaces:**
- Consumes: everything above.
- Produces: a recorded answer to the open cap question, and the PR.

- [ ] **Step 1: Verify the Responses tools-array cap against the live API**

This is the open item the spec records. Requires `OPENAI_API_KEY` and a gpt-5.4+
model. Start the API and demo, then send one real chat turn:

```bash
docker compose up -d postgres
pnpm migrate && pnpm seed
pnpm dev &                      # SpecR API on :3000
node examples/web_ui_demo/server.mjs &   # demo on :3001
curl -s localhost:3001/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"show me the submittals section in the architectural lighting control system spec"}]}' \
  | head -c 2000
```

Expected: `success: true`. If it fails with an array-length error, record the real
limit — that is the answer we were missing.

- [ ] **Step 2: Record the result in the spec**

Replace the open item under "Risks and open items" with the measured outcome —
either "verified: a 131-tool array with 126 deferred is accepted by the Responses
API on gpt-5.6-luna" or the real limit and how the code now handles it.

- [ ] **Step 3: Verify against the Anthropic path too**

```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... node examples/web_ui_demo/server.mjs &
curl -s localhost:3001/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"which sections cite 09 22 00?"}]}' | head -c 2000
```

Expected: `success: true`, and `toolCalls` shows `get_references` — a core tool,
so it should answer without a search round.

- [ ] **Step 4: Spot-check a report against pre-change behaviour**

The spec flags this: rewriting `REPORT_SYSTEM_PROMPT` can change report output.
Run one report through the demo UI and confirm it still cites real sections and
produces grounded narrative. Compare against `git stash`-ed pre-change output if
anything looks off.

- [ ] **Step 5: Run the repo's canonical verification**

```bash
pnpm lint
node --test "examples/web_ui_demo/*.test.mjs" "examples/web_ui_demo/providers/*.test.mjs"
pnpm test
```

Expected: all pass. `pnpm lint` covers `src/` only, but run it to prove no `src/`
drift crept in.

- [ ] **Step 6: Commit and open the draft PR**

```bash
git add -A docs/superpowers/specs/
git commit -m "docs(demo): record the verified Responses tools-array behaviour

Refs #546

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin fix/issue-546
```

Open as a **draft** (project rule — never ready-for-review directly):

```bash
gh pr create --draft --title "fix(demo): adopt native progressive tool discovery for the MCP chat" --body "..."
```

PR body must contain: why (the 131 > 128 failure and why the cap is the wrong
target), what (native tool search on both providers, IR replaced by adapters,
readable errors, CI gate), the LOC-over-500 heads-up with the reason it is
indivisible, the tickable Testing checklist, `Closes #546`, and the agent
attribution line.

- [ ] **Step 7: Move the board**

```bash
gh-project-move 546 "In review"
```

---

## Prior art (read before implementing)

- **PR #453** (`feat(demo): Anthropic API key + model support`) created
  `llm-providers.mjs`, the module Task 6 deletes. Its translation approach is
  superseded, not wrong — it predates native tool search.
- **PR #457** (`fix(demo): drop leading assistant turns so sliced Anthropic chat
  histories stay valid`) fixed a live bug inside that module: `chat.js` sends
  `history.slice(-CONTEXT_WINDOW)`, which can open the transcript on an assistant
  reply, and the Messages API rejects that. **Deleting the module must not delete
  the fix** — Task 4's `normalizeHistory` carries it forward and two tests pin it.
  Any reviewer should check that guard survived.

## Notes for the implementer

- **Do not add a tool-count clamp.** It was considered and rejected: OpenAI's own
  guidance is fewer than 20 tools per turn and Anthropic measures degradation past
  30–50, so a request clamped to 128 succeeds and answers badly. If a cap is ever
  needed it must throw, never truncate.
- **Do not defer write tools in `/report`.** Deferred still means discoverable.
  Write tools must be absent from that catalog entirely.
- **`server.anthropic.test.mjs` and `llm-providers.test.mjs` are deleted, not
  ported.** They test an IR that no longer exists. Their coverage is replaced by
  the adapter tests in Tasks 3 and 4.
- The demo has **no linting** (`pnpm lint` covers `src/` only). Match the
  surrounding style by hand: single quotes, semicolons, 2-space indent, 100-col
  comments.
