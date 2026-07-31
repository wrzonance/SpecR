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
