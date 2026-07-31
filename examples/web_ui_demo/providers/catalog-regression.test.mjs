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
