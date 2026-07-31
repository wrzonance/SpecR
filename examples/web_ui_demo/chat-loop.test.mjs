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
