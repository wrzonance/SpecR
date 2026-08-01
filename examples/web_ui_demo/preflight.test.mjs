// examples/web_ui_demo/preflight.test.mjs
// The launch-time provider check. Its whole value is that it fails when the
// demo would fail, so the probe must go through the real session interface with
// a deferred tool present — a bare "hello" call is known to succeed on a key the
// demo cannot actually use. Run:
//   node --test examples/web_ui_demo/preflight.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFLIGHT_CATALOG,
  PREFLIGHT_CORE_TOOLS,
  resolveProvider,
  runProviderCheck,
  formatResult,
} from './preflight.mjs';

const OK_SESSION = { async send() {} };

test('the probe catalog keeps at least one tool deferred, so tool search is exercised', () => {
  const deferred = PREFLIGHT_CATALOG.filter((t) => !PREFLIGHT_CORE_TOOLS.includes(t.name));
  assert.ok(deferred.length > 0, 'a deferred tool is what makes the adapter emit its search tool');
  assert.ok(PREFLIGHT_CATALOG.some((t) => PREFLIGHT_CORE_TOOLS.includes(t.name)));
});

test('the probe builds its session through the real adapter contract', async () => {
  let seen;
  const provider = resolveProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k' });
  const result = await runProviderCheck(provider, {
    createSessionImpl: (opts) => {
      seen = opts;
      return OK_SESSION;
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(seen.provider, 'openai');
  assert.equal(seen.catalog, PREFLIGHT_CATALOG);
  assert.equal(seen.coreToolNames, PREFLIGHT_CORE_TOOLS);
  assert.ok(seen.config.apiKey === 'k');
});

test('a provider rejection is reported as failed, carrying the actionable message', async () => {
  const err = Object.assign(new Error('Missing scopes: api.responses.write. Enable it.'), {
    code: 'invalid_request_error',
    detail: '{"error":{}}',
  });
  const result = await runProviderCheck(resolveProvider({ OPENAI_API_KEY: 'k' }), {
    createSessionImpl: () => ({
      async send() {
        throw err;
      },
    }),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /Missing scopes/);
  assert.equal(result.detail, '{"error":{}}');
  const lines = formatResult(result);
  assert.match(lines[0], /FAILED/);
  assert.match(lines[1], /still start/, 'a provider problem must not read as a fatal error');
});

test('a non-Error throw still produces a readable message rather than undefined', async () => {
  const result = await runProviderCheck(resolveProvider({ OPENAI_API_KEY: 'k' }), {
    createSessionImpl: () => ({
      async send() {
        throw 'socket hang up';
      },
    }),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /socket hang up/);
});

test('no key configured is skipped, not failed — chat is optional', async () => {
  const result = await runProviderCheck(resolveProvider({ OPENAI_API_KEY: '' }), {
    createSessionImpl: () => {
      throw new Error('must not build a session without a key');
    },
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /OPENAI_API_KEY/);
  assert.match(formatResult(result)[0], /skipped/);
});

test('an unsupported LLM_PROVIDER resolves to null and is skipped, not crashed', async () => {
  assert.equal(resolveProvider({ LLM_PROVIDER: 'gemini' }), null);
  const result = await runProviderCheck(null);
  assert.equal(result.status, 'skipped');
});

test('resolveProvider mirrors the server defaults for both providers', () => {
  const openai = resolveProvider({ OPENAI_API_KEY: 'k' });
  assert.equal(openai.name, 'openai', 'openai is the default provider');
  assert.equal(openai.config.baseUrl, 'https://api.openai.com/v1');
  assert.equal(openai.keyName, 'OPENAI_API_KEY');

  const anthropic = resolveProvider({ LLM_PROVIDER: 'Anthropic', ANTHROPIC_API_KEY: 'k' });
  assert.equal(anthropic.name, 'anthropic', 'LLM_PROVIDER is case-insensitive');
  assert.equal(anthropic.keyName, 'ANTHROPIC_API_KEY');
  assert.ok(anthropic.config.version, 'the Messages API requires a version header');
  assert.ok(anthropic.config.maxTokens > 0, 'the Messages API requires max_tokens');
});
