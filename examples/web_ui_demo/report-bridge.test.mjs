// Unit tests for the pure report-bridge orchestration helpers. Run with:
//   node --test examples/web_ui_demo/report-bridge.test.mjs
// These do NOT run in CI (examples/ is outside the vitest projects) — they are
// the demo's own regression net for the read-only grounded-reporting loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterReadOnlyTools,
  humanizeToolStep,
  dedupeAnchors,
  buildReportInput,
  runReport,
  clampToolText,
  MAX_TOOL_RESULT_CHARS,
  REPORT_SYSTEM_PROMPT,
} from './report-bridge.mjs';

test('filterReadOnlyTools keeps only readOnly tools — the write tools never reach the agent', () => {
  const tools = [
    { name: 'get_spec', readOnly: true },
    { name: 'update_paragraph', readOnly: false },
    { name: 'delete_project', readOnly: false },
  ];
  assert.deepEqual(
    filterReadOnlyTools(tools).map((t) => t.name),
    ['get_spec']
  );
});

test('humanizeToolStep gives a friendly label for known tools and falls back for unknown', () => {
  assert.match(humanizeToolStep('compare_specs', { sources: ['a', 'b'] }), /compar/i);
  assert.match(humanizeToolStep('coordination_report', {}), /coordination/i);
  assert.match(humanizeToolStep('get_spec_diff', {}), /diff/i);
  assert.match(humanizeToolStep('mystery_tool', {}), /mystery_tool/);
});

test('dedupeAnchors collapses duplicates, drops empties, and caps at 50', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    section: `09 ${i} 00`,
    specId: 's',
    paragraphId: 'p',
  }));
  const withDupAndEmpty = [
    ...many,
    { section: '09 0 00', specId: 's', paragraphId: 'p' }, // exact duplicate of many[0]
    { section: '', specId: 's' }, // empty section ⇒ dropped
    null, // junk ⇒ dropped
  ];
  const out = dedupeAnchors(withDupAndEmpty);
  assert.equal(out.length, 50);
  assert.ok(out.every((a) => typeof a.section === 'string' && a.section !== ''));
});

test('buildReportInput seeds userContent with the request and scope label', () => {
  const { userContent } = buildReportInput('compare 03 30 00', { label: 'Projects: A, B' });
  assert.match(userContent, /03 30 00/);
  assert.match(userContent, /A, B/);
});

test('buildReportInput omits the scope line when no label is given', () => {
  const { userContent } = buildReportInput('hello', undefined);
  assert.equal(userContent, 'hello');
});

test('REPORT_SYSTEM_PROMPT tells the model most tools are discovered on demand', () => {
  assert.match(REPORT_SYSTEM_PROMPT, /not preloaded|search for them/i);
});

// A fake session honouring the shared interface, driven by a fixed queue of
// send() replies — the same double chat-loop.test.mjs uses.
function fakeSession(
  turns,
  { finalText = 'final', finalUsage = { inputTokens: 0, outputTokens: 0 } } = {}
) {
  return {
    async send() {
      return turns.shift();
    },
    addToolResults() {},
    async finalize() {
      return { text: finalText, usage: finalUsage };
    },
  };
}

test('runReport runs the tool loop, emits steps, returns deterministic citations', async () => {
  const anchor = { section: '03 30 00', specId: 's1', paragraphId: 'p1' };
  const deps = {
    listTools: async () => [
      { name: 'compare_specs', description: 'd', inputSchema: {}, readOnly: true },
    ],
    createSession: () =>
      fakeSession([
        {
          text: '',
          toolCalls: [{ id: 't1', name: 'compare_specs', args: { sources: ['s1', 's2'] } }],
          usage: { inputTokens: 5, outputTokens: 5 },
        },
        {
          text: 'Section 03 30 00 diverges.',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 5 },
        },
      ]),
    execTool: async () => ({ text: '{"rows":[]}', ok: true, anchors: [anchor, anchor] }),
  };
  const steps = [];
  const out = await runReport({
    request: 'compare 03 30 00',
    scope: undefined,
    deps,
    limits: { maxRounds: 4, maxToolCalls: 8, tokenBudget: 100000 },
    emit: (e) => steps.push(e),
  });
  assert.match(out.reply, /diverges/);
  assert.deepEqual(out.citations, [anchor]); // deduped
  assert.ok(
    steps.some((s) => s.type === 'step' && s.tool === 'compare_specs' && s.status === 'running')
  );
  assert.ok(
    steps.some((s) => s.type === 'step' && s.tool === 'compare_specs' && s.status === 'done')
  );
  assert.ok(steps.some((s) => s.type === 'usage'));
  assert.equal(out.toolCalls[0].ok, true);
  assert.equal(out.usage.toolCalls, 1);
});

test('runReport builds its session over the READ-ONLY pool only', async () => {
  // The security invariant: if write tools were deferred rather than excluded,
  // the model could DISCOVER and call one via tool search.
  let seenCatalog = null;
  const deps = {
    listTools: async () => [
      { name: 'get_spec', description: 'd', inputSchema: {}, readOnly: true },
      { name: 'list_projects', description: 'd', inputSchema: {}, readOnly: true },
      { name: 'update_paragraph', description: 'd', inputSchema: {}, readOnly: false },
    ],
    createSession: ({ catalog }) => {
      seenCatalog = catalog;
      return fakeSession([
        { text: 'report body', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
    },
    execTool: async () => ({ text: 'x', ok: true, anchors: [] }),
  };
  await runReport({
    request: 'compare things',
    scope: {},
    deps,
    limits: { maxRounds: 4, maxToolCalls: 4, tokenBudget: 100000 },
    emit: () => {},
  });
  assert.deepEqual(
    seenCatalog.map((t) => t.name),
    ['get_spec', 'list_projects'],
    'update_paragraph must be absent entirely, not merely deferred'
  );
});

test('runReport enforces the execution-time allow-list as defence in depth', async () => {
  const emitted = [];
  const deps = {
    listTools: async () => [
      { name: 'get_spec', description: 'd', inputSchema: {}, readOnly: true },
    ],
    createSession: () =>
      fakeSession([
        {
          text: '',
          toolCalls: [{ id: 'evil', name: 'update_paragraph', args: {} }],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          text: 'Done — no writes performed.',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    // Spy: records every invocation. Must NEVER be called for a disallowed tool.
    execTool: async () => {
      throw new Error('execTool must never run for a disallowed tool');
    },
  };
  const out = await runReport({
    request: 'summarize the coordination report',
    scope: undefined,
    deps,
    limits: { maxRounds: 4, maxToolCalls: 8, tokenBudget: 100000 },
    emit: (e) => emitted.push(e),
  });
  // The write tool NEVER reached MCP; the blocked call was surfaced as an
  // error step keyed by tool/label/status — js/compose.js's renderStep contract.
  assert.ok(
    emitted.some(
      (e) =>
        e.type === 'step' &&
        e.tool === 'update_paragraph' &&
        e.status === 'error' &&
        /not a read-only tool/i.test(e.label ?? '')
    )
  );
  assert.deepEqual(out.toolCalls, [{ name: 'update_paragraph', ok: false }]);
  // …and a tool response was still fed back (the session got a second turn and
  // answered), so blocking did not corrupt the transcript.
  assert.match(out.reply, /no writes/i);
});

test('runReport stops mid-batch when the per-call budget is exhausted — excess calls never reach MCP', async () => {
  // One turn carries FIVE tool calls; the budget is 2. Only two may execute;
  // the rest are skipped WITHOUT touching MCP — proving the gate is checked
  // per call inside the batch, not once after the whole round completes.
  const execToolCalls = [];
  const fiveCalls = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    name: 'list_projects',
    args: {},
  }));
  const deps = {
    listTools: async () => [
      { name: 'list_projects', description: 'd', inputSchema: {}, readOnly: true },
    ],
    createSession: () =>
      fakeSession(
        [{ text: '', toolCalls: fiveCalls, usage: { inputTokens: 1, outputTokens: 1 } }],
        {
          finalText: 'Capped — partial scope.',
        }
      ),
    execTool: async (call) => {
      execToolCalls.push(call.id);
      return { text: '[]', ok: true, anchors: [] };
    },
  };
  const steps = [];
  const out = await runReport({
    request: 'list everything',
    scope: undefined,
    deps,
    limits: { maxRounds: 6, maxToolCalls: 2, tokenBudget: 100000 },
    emit: (e) => steps.push(e),
  });
  assert.equal(execToolCalls.length, 2, `expected 2 MCP calls, got ${execToolCalls.length}`);
  const skipped = steps.filter((s) => s.type === 'step' && /budget/i.test(s.label || ''));
  assert.equal(skipped.length, 3);
  assert.equal(typeof out.reply, 'string');
  assert.ok(out.reply.length > 0);
  // The reported "grounded call" count must reflect calls that actually
  // reached MCP, not the 3 calls skipped for being over budget.
  assert.equal(
    out.toolCalls.length,
    2,
    `reported toolCalls must exclude budget-skipped calls, got ${out.toolCalls.length}`
  );
  assert.equal(out.usage.toolCalls, 2);
});

test('clampToolText truncates an oversized MCP result with an explicit marker', () => {
  assert.equal(clampToolText('short'), 'short');
  assert.equal(clampToolText(null), '');
  const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
  const out = clampToolText(big);
  assert.ok(out.length < big.length);
  assert.match(out, /truncated 500 chars/);
});

test('clampToolText is idempotent — the transport and boundary guards never double-mark', () => {
  const once = clampToolText('x'.repeat(MAX_TOOL_RESULT_CHARS + 500));
  assert.equal(clampToolText(once), once);
  assert.equal(once.match(/truncated/g).length, 1);
});

test('runReport tracks real provider usage and stops once the token budget is exceeded', async () => {
  const deps = {
    listTools: async () => [
      { name: 'coordination_report', description: 'd', inputSchema: {}, readOnly: true },
    ],
    createSession: () =>
      fakeSession(
        [
          {
            text: '',
            toolCalls: [{ id: 't', name: 'coordination_report', args: {} }],
            usage: { inputTokens: 90000, outputTokens: 40000 },
          },
          {
            text: '',
            toolCalls: [{ id: 't2', name: 'coordination_report', args: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ],
        { finalText: 'summary.' }
      ),
    execTool: async () => ({ text: 'x', ok: true, anchors: [] }),
  };
  const out = await runReport({
    request: 'coordination report',
    scope: undefined,
    deps,
    limits: { maxRounds: 4, maxToolCalls: 8, tokenBudget: 120000 },
    emit: () => {},
  });
  assert.equal(
    out.usage.tokens,
    130000,
    'usage.tokens should be the real provider total, not an estimate'
  );
  assert.match(out.reply, /summary/);
});

test("runReport counts session.finalize()'s own usage toward the reported token total", async () => {
  // The forced closing call via session.finalize() costs real input/output
  // tokens too — omitting it under-reports the cost/scope guardrail metric
  // that js/compose.js's renderUsage surfaces to the user.
  const deps = {
    listTools: async () => [
      { name: 'list_projects', description: 'd', inputSchema: {}, readOnly: true },
    ],
    createSession: () => ({
      async send() {
        return {
          text: '',
          toolCalls: [{ id: 't1', name: 'list_projects', args: {} }],
          usage: { inputTokens: 100000, outputTokens: 25000 }, // trips the 120000 token budget
        };
      },
      addToolResults() {},
      async finalize() {
        return { text: 'final summary.', usage: { inputTokens: 3000, outputTokens: 1500 } };
      },
    }),
    execTool: async () => ({ text: 'x', ok: true, anchors: [] }),
  };
  const out = await runReport({
    request: 'x',
    scope: undefined,
    deps,
    limits: { maxRounds: 4, maxToolCalls: 8, tokenBudget: 120000 },
    emit: () => {},
  });
  assert.equal(
    out.usage.tokens,
    129500,
    "usage.tokens must include finalize()'s own token cost, not just prior rounds"
  );
});

test('runReport reports the ACTUAL rounds used after a budget break, not the max', async () => {
  // Budget (2 calls) trips after round 2 of a max-10 loop; usage.rounds must read 2.
  const deps = {
    listTools: async () => [
      { name: 'list_projects', description: 'd', inputSchema: {}, readOnly: true },
    ],
    createSession: () => {
      let round = 0;
      return {
        async send() {
          round += 1;
          return {
            text: '',
            toolCalls: [{ id: `t${round}`, name: 'list_projects', args: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        addToolResults() {},
        async finalize() {
          return { text: 'capped.', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
    },
    execTool: async () => ({ text: '[]', ok: true, anchors: [] }),
  };
  const out = await runReport({
    request: 'x',
    scope: undefined,
    deps,
    limits: { maxRounds: 10, maxToolCalls: 2, tokenBudget: 100000 },
    emit: () => {},
  });
  assert.equal(out.usage.rounds, 2, `expected 2 rounds, got ${out.usage.rounds}`);
});
