// examples/web_ui_demo/mcp-bridge.test.mjs
// The MCP transport's two guarantees: a tool result is never shortened without
// saying so, and no round-trip can hang forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpBridge, clampToolText, MAX_TOOL_RESULT_CHARS } from './mcp-bridge.mjs';

// Minimal JSON-RPC stand-in for the SpecR MCP endpoint. `respond` receives the
// parsed request body and returns the `result` payload.
function stubFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), signal: init.signal });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: respond(JSON.parse(init.body)) }),
    };
  };
  impl.calls = calls;
  return impl;
}

function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test('an oversized tool result is truncated WITH the marker, never silently', async () => {
  const oversized = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
  const impl = stubFetch(() => ({ content: [{ text: oversized }] }));
  const out = await withFetch(impl, () =>
    createMcpBridge('http://mcp.test').execToolCall({ id: 'c1', name: 'get_spec', args: {} })
  );
  assert.ok(out.text.length < oversized.length, 'result must be bounded');
  assert.match(out.text, /truncated 500 chars/, 'truncation must be disclosed to the model');
});

test('a result at or under the cap passes through untouched', async () => {
  const impl = stubFetch(() => ({ content: [{ text: 'small result' }] }));
  const out = await withFetch(impl, () =>
    createMcpBridge('http://mcp.test').execToolCall({ id: 'c1', name: 'get_spec', args: {} })
  );
  assert.equal(out.text, 'small result');
});

test('clampToolText is the single truncation contract shared with report-bridge', () => {
  assert.equal(clampToolText('short'), 'short');
  assert.equal(clampToolText(null), '');
  const marked = clampToolText('y'.repeat(MAX_TOOL_RESULT_CHARS + 12));
  assert.equal(clampToolText(marked), marked, 'must be idempotent');
});

test('a wedged MCP endpoint aborts on the bridge timeout rather than hanging', async () => {
  // Never resolves on its own — only the abort signal can end it.
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const out = await withFetch(hang, () =>
    createMcpBridge('http://mcp.test', { timeoutMs: 25 }).execToolCall({
      id: 'c1',
      name: 'get_spec',
      args: {},
    })
  );
  // execToolCall never throws — a failed tool becomes a result the model reacts to.
  assert.equal(out.ok, false);
  assert.match(out.text, /tool error/);
});

// A transport-level failure must never be parsed into a plausible-looking tool
// result: the model would treat the fabricated text as grounding.
function respondWith({ ok = true, status = 200, contentType = 'application/json', body }) {
  return async () => ({
    ok,
    status,
    headers: { get: () => contentType },
    text: async () => body,
  });
}

const execWithBase = (impl, apiBase = 'http://mcp.test') =>
  withFetch(impl, () =>
    createMcpBridge(apiBase).execToolCall({ id: 'c1', name: 'get_spec', args: {} })
  );

test('a non-2xx MCP response surfaces as a tool error, not a phantom result', async () => {
  const impl = respondWith({
    ok: false,
    status: 503,
    body: '{"success":false,"error":"upstream down"}',
  });
  const out = await execWithBase(impl);
  assert.equal(out.ok, false);
  assert.match(out.text, /MCP HTTP 503/);
});

test('a JSON-RPC error envelope surfaces as a tool error, not a successful result', async () => {
  const impl = respondWith({
    body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"unknown tool"}}',
  });
  const out = await execWithBase(impl);
  assert.equal(out.ok, false);
  assert.match(out.text, /unknown tool/);
});

test('a response with no result and no error is rejected rather than read as empty', async () => {
  const impl = respondWith({ body: '{"jsonrpc":"2.0","id":1}' });
  const out = await execWithBase(impl);
  assert.equal(out.ok, false);
  assert.match(out.text, /missing result/);
});

test('an SSE response body is parsed — with and without the optional space after data:', async () => {
  const result = '{"jsonrpc":"2.0","id":1,"result":{"content":[{"text":"sse ok"}]}}';
  for (const field of [`data: ${result}`, `data:${result}`]) {
    const impl = respondWith({
      contentType: 'text/event-stream',
      body: `event: message\n${field}\n\n`,
    });
    const out = await execWithBase(impl);
    assert.equal(out.text, 'sse ok', `failed for field form: ${field.slice(0, 6)}`);
  }
});

test('an SSE value split across several data lines is rejoined before parsing', async () => {
  const impl = respondWith({
    contentType: 'text/event-stream',
    body: 'event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"content":[{"text":"joined"}]}}\n\n',
  });
  const out = await execWithBase(impl);
  assert.equal(out.text, 'joined');
});

test('a SPECR_API_BASE path prefix is preserved — the endpoint is {apiBase}/mcp', async () => {
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{"jsonrpc":"2.0","id":1,"result":{"content":[{"text":"ok"}]}}',
    };
  };
  await execWithBase(impl, 'https://gw.example/specr');
  await execWithBase(impl, 'https://gw.example/specr/');
  await execWithBase(impl, 'http://127.0.0.1:3000');
  assert.deepEqual(seen, [
    'https://gw.example/specr/mcp',
    'https://gw.example/specr/mcp',
    'http://127.0.0.1:3000/mcp',
  ]);
});
