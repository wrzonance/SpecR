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
  estimateTokens,
  buildReportMessages,
  runReport,
  REPORT_SYSTEM_PROMPT,
} from './report-bridge.mjs';

test('filterReadOnlyTools keeps only read-only tools', () => {
  const tools = [
    { function: { name: 'coordination_report' }, __readOnly: true },
    { function: { name: 'create_project' }, __readOnly: false },
    { function: { name: 'unknown_tier' } }, // missing flag ⇒ treated as not read-only
  ];
  const kept = filterReadOnlyTools(tools);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].function.name, 'coordination_report');
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

test('estimateTokens approximates 4 chars per token', () => {
  assert.equal(estimateTokens([{ content: 'x'.repeat(40) }]), 10);
  assert.equal(estimateTokens([{ content: null }, {}]), 0);
});

test('buildReportMessages seeds system + user with the request and scope label', () => {
  const msgs = buildReportMessages(
    'compare 03 30 00',
    { label: 'Projects: A, B' },
    REPORT_SYSTEM_PROMPT
  );
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, REPORT_SYSTEM_PROMPT);
  assert.equal(msgs.at(-1).role, 'user');
  assert.match(msgs.at(-1).content, /03 30 00/);
  assert.match(msgs.at(-1).content, /A, B/);
});

test('buildReportMessages omits the scope line when no label is given', () => {
  const msgs = buildReportMessages('hello', undefined, REPORT_SYSTEM_PROMPT);
  assert.equal(msgs.length, 2);
  assert.equal(msgs.at(-1).content, 'hello');
});

test('runReport runs the tool loop, emits steps, returns deterministic citations', async () => {
  const anchor = { section: '03 30 00', specId: 's1', paragraphId: 'p1' };
  const deps = {
    listTools: async () => [{ function: { name: 'compare_specs' }, __readOnly: true }],
    callModel: async (messages) => {
      const priorTool = messages.some((m) => m.role === 'tool');
      return priorTool
        ? { choices: [{ message: { role: 'assistant', content: 'Section 03 30 00 diverges.' } }] }
        : {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 't1',
                      function: { name: 'compare_specs', arguments: '{"sources":["s1","s2"]}' },
                    },
                  ],
                },
              },
            ],
          };
    },
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

test('runReport surfaces the read-only tool set to the model (no write tools reach it)', async () => {
  let toolsSeen = null;
  const deps = {
    listTools: async () => [
      { function: { name: 'coordination_report' }, __readOnly: true },
      { function: { name: 'create_project' }, __readOnly: false },
    ],
    callModel: async (_messages, tools) => {
      toolsSeen = tools;
      return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
    },
    execTool: async () => ({ text: '', ok: true, anchors: [] }),
  };
  await runReport({
    request: 'x',
    scope: undefined,
    deps,
    limits: { maxRounds: 4, maxToolCalls: 8, tokenBudget: 100000 },
    emit: () => {},
  });
  assert.deepEqual(
    toolsSeen.map((t) => t.function.name),
    ['coordination_report']
  );
});

test('runReport stops at maxToolCalls and still returns a reply', async () => {
  const deps = {
    listTools: async () => [{ function: { name: 'list_projects' }, __readOnly: true }],
    callModel: async (messages) => {
      // Always ask for another tool call unless tools are disabled (final turn).
      const toolsDisabled = messages.at(-1)?.role === 'tool' && messages.length > 8;
      if (toolsDisabled)
        return { choices: [{ message: { role: 'assistant', content: 'capped.' } }] };
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 't', function: { name: 'list_projects', arguments: '{}' } }],
            },
          },
        ],
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
  assert.ok(out.toolCalls.length <= 2, `expected <= 2 tool calls, got ${out.toolCalls.length}`);
  assert.equal(typeof out.reply, 'string');
  assert.ok(out.reply.length > 0);
});

test('rejects a tool call outside the read-only allow-list — never reaches MCP', async () => {
  // The MCP server advertises a write tool, but filterReadOnlyTools drops it, so it
  // is NOT in the allow-list. The model nonetheless emits a call to it (hallucinated
  // or injected via untrusted content). It must be blocked before touching MCP.
  const execToolCalls = [];
  const deps = {
    listTools: async () => [
      { function: { name: 'coordination_report' }, __readOnly: true },
      { function: { name: 'update_paragraph' }, __readOnly: false },
    ],
    callModel: async (messages) => {
      const sawToolResult = messages.some((m) => m.role === 'tool');
      return sawToolResult
        ? { choices: [{ message: { role: 'assistant', content: 'Done — no writes performed.' } }] }
        : {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'evil',
                      function: {
                        name: 'update_paragraph',
                        arguments: '{"paragraphId":"p","text":"pwned"}',
                      },
                    },
                  ],
                },
              },
            ],
          };
    },
    // Spy: records every invocation. Must NEVER be called for a blocked tool.
    execTool: async (call) => {
      execToolCalls.push(call.function?.name);
      return { text: 'ok', ok: true, anchors: [] };
    },
  };
  const steps = [];
  const out = await runReport({
    request: 'summarize the coordination report',
    scope: undefined,
    deps,
    limits: { maxRounds: 4, maxToolCalls: 8, tokenBudget: 100000 },
    emit: (e) => steps.push(e),
  });
  // The write tool NEVER reached MCP.
  assert.deepEqual(execToolCalls, [], 'execTool (MCP) must not be invoked for a blocked tool');
  // The blocked call was surfaced as an error step and recorded ok:false…
  assert.ok(
    steps.some((s) => s.type === 'step' && s.tool === 'update_paragraph' && s.status === 'error')
  );
  assert.deepEqual(out.toolCalls, [{ name: 'update_paragraph', ok: false }]);
  // …and a tool response was still fed back (the model got a second turn and
  // answered), so blocking did not corrupt the message history.
  assert.match(out.reply, /no writes/i);
});

test('stops mid-batch when maxToolCalls budget is exhausted — excess calls never reach MCP', async () => {
  // One assistant message carries FIVE tool calls; the budget is 2. Only two may
  // execute; the rest are skipped without touching MCP, yet every tool_call_id is
  // answered so the forced final turn has a valid message history.
  const execToolCalls = [];
  const fiveCalls = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    function: { name: 'list_projects', arguments: '{}' },
  }));
  const deps = {
    listTools: async () => [{ function: { name: 'list_projects' }, __readOnly: true }],
    callModel: async (_messages, tools) =>
      tools.length === 0
        ? { choices: [{ message: { role: 'assistant', content: 'Capped — partial scope.' } }] }
        : {
            choices: [{ message: { role: 'assistant', content: null, tool_calls: fiveCalls } }],
          },
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
  // At most the budget's worth of calls actually hit MCP.
  assert.equal(execToolCalls.length, 2, `expected 2 MCP calls, got ${execToolCalls.length}`);
  // The over-budget calls were surfaced as skip steps.
  const skipped = steps.filter((s) => s.type === 'step' && /budget/i.test(s.label || ''));
  assert.equal(skipped.length, 3);
  assert.equal(typeof out.reply, 'string');
  assert.ok(out.reply.length > 0);
});
