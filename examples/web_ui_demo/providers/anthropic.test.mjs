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

test('a history starting on multiple assistant turns has all of them dropped, not just the first', async () => {
  // The /chat boundary forwards whatever role sequence the client sends
  // (chat.js's history.slice can land on any offset), so more than one
  // leading assistant turn is a realistic input, not just exactly one.
  const fetchImpl = stubFetch([textResponse('ok')]);
  const session = createAnthropicSession({
    system: 'SYS',
    userMessages: [
      { role: 'assistant', content: 'stale reply 1' },
      { role: 'assistant', content: 'stale reply 2' },
      { role: 'user', content: 'real question' },
    ],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  await session.send();
  const { messages } = fetchImpl.calls[0].body;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'real question');
});

test('a history of only assistant turns normalizes to an empty transcript', async () => {
  const fetchImpl = stubFetch([textResponse('ok')]);
  const session = createAnthropicSession({
    system: 'SYS',
    userMessages: [
      { role: 'assistant', content: 'stale reply 1' },
      { role: 'assistant', content: 'stale reply 2' },
    ],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  await session.send();
  const { messages } = fetchImpl.calls[0].body;
  assert.deepEqual(messages, []);
});

test('empty turns are dropped — the Messages API rejects a turn with empty content', async () => {
  const fetchImpl = stubFetch([textResponse('ok')]);
  const session = createAnthropicSession({
    system: 'SYS',
    userMessages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'second' },
    ],
    catalog,
    coreToolNames: ['list_projects'],
    config: CONFIG,
    fetchImpl,
  });
  await session.send();
  const { messages } = fetchImpl.calls[0].body;
  // The blank assistant turn is gone, so the two user turns coalesce rather
  // than straddling an invalid message.
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content, /first[\s\S]*second/);
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

// Symmetry with the OpenAI adapter (see openai.test.mjs): with nothing deferred
// the search tool has nothing to find, so it is not sent. Everything left is
// non-deferred, which is what the Messages API requires.
test('anthropic: the bm25 search tool is omitted when nothing is deferred', async () => {
  const fetchImpl = stubFetch([textResponse('hello')]);
  const session = createAnthropicSession({
    system: 'SYS',
    userMessages: [{ role: 'user', content: 'hi' }],
    catalog,
    coreToolNames: catalog.map((t) => t.name),
    config: CONFIG,
    fetchImpl,
  });
  await session.send();
  const { body } = fetchImpl.calls[0];
  assert.ok(
    !body.tools.some((t) => t.type === 'tool_search_tool_bm25_20251119'),
    'no deferred tools ⇒ no search tool'
  );
  assert.ok(
    body.tools.every((t) => !t.defer_loading),
    'everything left is non-deferred'
  );
});
