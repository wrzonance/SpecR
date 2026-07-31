// examples/web_ui_demo/chat-error-view.test.mjs
// The error bubble is built with createElement + textContent only — no
// innerHTML anywhere in the error path. Run:
//   node --test examples/web_ui_demo/chat-error-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorBubble } from './js/chat-error-view.mjs';

// Minimal DOM stub: enough for createElement/appendChild/textContent.
function fakeDocument() {
  const make = (tag) => ({
    tag,
    className: '',
    textContent: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  });
  return { createElement: make };
}

const flatten = (node) => [node, ...node.children.flatMap(flatten)];

test('buildErrorBubble shows the clean message and never the raw JSON inline', () => {
  const bubble = buildErrorBubble(fakeDocument(), {
    error: "Invalid 'tools': array too long.",
    code: 'array_above_max_length',
    detail: '{"error":{"message":"Invalid \'tools\': array too long."}}',
  });
  const texts = flatten(bubble).map((n) => n.textContent);
  assert.ok(texts.includes("Invalid 'tools': array too long."));
  // The raw body must not be the bubble's primary text.
  const primary = flatten(bubble).find((n) => n.className.includes('chat-text'));
  assert.ok(!primary.textContent.includes('{'));
});

test('buildErrorBubble puts the raw detail behind a details/summary disclosure', () => {
  const bubble = buildErrorBubble(fakeDocument(), {
    error: 'bad',
    code: 'x',
    detail: 'RAW BODY HERE',
  });
  const nodes = flatten(bubble);
  assert.ok(nodes.some((n) => n.tag === 'details'));
  assert.ok(nodes.some((n) => n.tag === 'summary'));
  assert.ok(nodes.some((n) => n.textContent === 'RAW BODY HERE'));
});

test('buildErrorBubble omits the disclosure entirely when there is no detail', () => {
  const bubble = buildErrorBubble(fakeDocument(), { error: 'no key configured', code: 'no-key', detail: '' });
  assert.ok(!flatten(bubble).some((n) => n.tag === 'details'));
});

test('buildErrorBubble marks the bubble as an error for styling', () => {
  const bubble = buildErrorBubble(fakeDocument(), { error: 'bad', code: null, detail: '' });
  assert.match(bubble.className, /is-error/);
});
