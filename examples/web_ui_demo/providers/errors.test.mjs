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

// Reported live (2026-08-01) running the demo against a restricted OpenAI key:
// the chat rendered OpenAI's scope jargon with no action the operator could
// take. This PR's migration to the Responses API is what surfaces it — a key
// granted only Chat Completions passes every other check and fails here.
test('a missing Responses scope is translated into an actionable hint', () => {
  const body = JSON.stringify({
    error: {
      message:
        'You have insufficient permissions for this operation. Missing scopes: api.responses.write. Check that you have the correct role in your organization (Reader, Writer, Owner) and project (Member, Owner), and if you’re using a restricted API key, that it has the necessary scopes.',
      type: 'invalid_request_error',
      param: null,
      code: null,
    },
  });
  const err = normalizeProviderError('openai', 401, body);
  assert.match(err.message, /Missing scopes/, 'the provider sentence is preserved');
  assert.match(
    err.message,
    /Responses/i,
    'the hint must name the Responses permission the key is missing'
  );
  assert.match(err.message, /OPENAI_API_KEY/, 'and point at the key the demo actually reads');
  assert.equal(err.detail, body, 'raw body still kept separate for the disclosure');
});
