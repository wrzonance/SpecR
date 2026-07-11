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

test('a history sliced to start on an assistant reply drops the leading assistant turns', () => {
  // chat.js sends history.slice(-CONTEXT_WINDOW): after enough exchanges the
  // window starts on an assistant reply, which the Messages API rejects.
  const { messages } = toAnthropicRequest([
    { role: 'system', content: 'You are the SpecR assistant.' },
    { role: 'assistant', content: 'orphaned reply from a truncated exchange' },
    { role: 'user', content: 'next question' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'latest question' },
  ]);
  assert.equal(messages[0].role, 'user');
  assert.deepEqual(messages, [
    { role: 'user', content: 'next question' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'user', content: 'latest question' },
  ]);
});
