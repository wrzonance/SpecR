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
