// Black-box integration test for the demo's POST /report streaming bridge (#353).
// Spawns server.mjs as a child process pointed at a mock OpenAI Responses API
// endpoint and a mock SpecR MCP endpoint, then asserts the NDJSON stream
// (step → usage → done) and that the internal `readOnly` flag never leaks onto
// the OpenAI wire. Run:
//   node --test examples/web_ui_demo/server.report.test.mjs
// Not part of CI (examples/ is outside the vitest projects).
//
// NOTE (#546): this mock speaks the Responses API (POST /responses), not the
// retired Chat Completions wire — /report now runs on the same progressive
// tool-discovery session interface as /chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
  });
}

// A single mock that plays both the SpecR MCP endpoint (POST /mcp) and the
// OpenAI Responses endpoint (POST /v1/responses).
function startMock(captured) {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mcp') return res.end(JSON.stringify(mcpResponse(body, captured)));
    if (req.url.endsWith('/responses')) {
      captured.openaiBodies.push(body);
      return res.end(JSON.stringify(responsesReply(body, captured)));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return server;
}

function mcpResponse(body, captured) {
  if (body.method === 'tools/call') captured.mcpToolCalls.push(body.params?.name);
  if (body.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        tools: [
          // A REPORT_CORE_TOOLS name must be present, or splitCoreAndDeferred
          // (both real adapters use it) throws — every provider rejects an
          // all-deferred tool set.
          {
            name: 'list_projects',
            description: 'List projects',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'coordination_report',
            description: 'E&O report',
            inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'create_project',
            description: 'writes',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: false },
          },
        ],
      },
    };
  }
  // tools/call → grounded result carrying a navigation anchor in _meta.
  return {
    jsonrpc: '2.0',
    id: body.id,
    result: {
      content: [{ type: 'text', text: '{"findings":[]}' }],
      _meta: { 'specr/anchors': [{ section: '03 30 00', specId: 's1', paragraphId: 'p1' }] },
    },
  };
}

// Responses-API-shaped reply. `input` carries the running transcript; a
// function_call_output item means a tool already ran this conversation.
function responsesReply(body, captured) {
  const usedTool = (body.input || []).some((item) => item.type === 'function_call_output');
  if (usedTool) {
    return {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '03 30 00 has no coordination findings.' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  // First turn emits a tool call. Tests can override which tool the model asks
  // for (e.g. a write tool it should never be allowed to execute).
  const toolName = captured.firstCallTool || 'coordination_report';
  return {
    output: [
      { type: 'function_call', call_id: 'call_1', name: toolName, arguments: '{"projectId":"p"}' },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// Spawn the demo server as a child pointed at the mock. Kept in one place so every
// test wires the same env.
function spawnDemo(mockPort, demoPort) {
  return spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(demoPort),
      HOST: '127.0.0.1',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-5.6-luna',
      OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      SPECR_API_BASE: `http://127.0.0.1:${mockPort}`,
    },
    stdio: 'ignore',
  });
}

// Cleanup that AWAITS the child's exit before returning, so its listening socket
// is released before the file's next test spawns — otherwise the OS may still hold
// the port and the next bind/waitForPort flakes to a timeout.
async function stopDemo(child, mock) {
  child.kill();
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  mock.close();
}

test('POST /report streams grounded steps + a done event with deterministic citations', async (t) => {
  const captured = { openaiBodies: [], mcpToolCalls: [] };
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 7;

  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));

  // Wait for the demo server to accept connections.
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'coordination report for the active project' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/x-ndjson/);

  const events = (await res.text())
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));

  const steps = events.filter((e) => e.type === 'step');
  const done = events.find((e) => e.type === 'done');
  assert.ok(steps.some((s) => s.tool === 'coordination_report' && s.status === 'running'));
  assert.ok(steps.some((s) => s.tool === 'coordination_report' && s.status === 'done'));
  assert.ok(events.some((e) => e.type === 'usage'));
  assert.ok(done, 'expected a done event');
  assert.match(done.reply, /coordination findings/);
  assert.deepEqual(done.citations, [{ section: '03 30 00', specId: 's1', paragraphId: 'p1' }]);

  // The write tool (create_project) must never be sent to OpenAI, and the
  // internal `readOnly` flag must be stripped before hitting the wire.
  const firstBody = captured.openaiBodies[0];
  const toolNames = (firstBody.tools || [])
    .filter((ttool) => ttool.type === 'function')
    .map((ttool) => ttool.name);
  assert.ok(!toolNames.includes('create_project'), 'a write tool must never reach the provider');
  assert.ok(
    (firstBody.tools || []).every((ttool) => !('readOnly' in ttool) && !('__readOnly' in ttool)),
    'readOnly must not be sent to OpenAI'
  );
});

test('POST /report — a model-emitted write tool never reaches MCP (deny-by-default at the boundary)', async (t) => {
  // The model asks to call create_project (write tier). The bridge advertises only
  // read-only tools, so create_project is off the allow-list and must be blocked at
  // the execution boundary — MCP tools/call must never see it end-to-end.
  const captured = { openaiBodies: [], mcpToolCalls: [], firstCallTool: 'create_project' };
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 8;

  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'please rename the project' }),
  });
  const events = (await res.text())
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));

  // MCP never executed the write tool…
  assert.ok(
    !captured.mcpToolCalls.includes('create_project'),
    `MCP must not execute the blocked write tool; saw: ${JSON.stringify(captured.mcpToolCalls)}`
  );
  // …it was surfaced as a blocked step, and the report still completed.
  assert.ok(
    events.some((e) => e.type === 'step' && e.tool === 'create_project' && e.status === 'error')
  );
  assert.ok(events.some((e) => e.type === 'done'));
});

test('POST /report rejects an oversized body without buffering it whole', async (t) => {
  const captured = { openaiBodies: [], mcpToolCalls: [] };
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 9;

  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  // ~1 MiB body — far over the 16 KiB cap.
  const huge = 'z'.repeat(1024 * 1024);
  const res = await fetch(`http://127.0.0.1:${demoPort}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: huge }),
  });
  const events = (await res.text())
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));

  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'expected an error event');
  assert.match(err.error, /too large/i);
  // The oversized request never reached the model.
  assert.equal(captured.openaiBodies.length, 0);
});

async function waitForPort(port) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`).catch(() => {});
      const probe = await fetch(`http://127.0.0.1:${port}/`);
      if (probe.status) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`demo server did not come up on ${port}`);
}
