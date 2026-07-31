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
