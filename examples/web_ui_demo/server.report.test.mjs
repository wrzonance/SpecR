// Black-box integration test for the demo's POST /report streaming bridge (#353).
// Spawns server.mjs as a child process pointed at a mock OpenAI endpoint and a
// mock SpecR MCP endpoint, then asserts the NDJSON stream (step → usage → done)
// and that our internal __readOnly flag never leaks onto the OpenAI wire. Run:
//   node --test examples/web_ui_demo/server.report.test.mjs
// Not part of CI (examples/ is outside the vitest projects).
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
// OpenAI chat-completions endpoint (POST /v1/chat/completions).
function startMock(captured) {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mcp') return res.end(JSON.stringify(mcpResponse(body, captured)));
    if (req.url.endsWith('/chat/completions')) {
      captured.openaiBodies.push(body);
      return res.end(JSON.stringify(openaiResponse(body, captured)));
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

function openaiResponse(body, captured) {
  const usedTool = body.messages.some((m) => m.role === 'tool');
  if (usedTool) {
    return {
      choices: [
        { message: { role: 'assistant', content: '03 30 00 has no coordination findings.' } },
      ],
    };
  }
  // First turn emits a tool call. Tests can override which tool the model asks for
  // (e.g. a write tool it should never be allowed to execute).
  const toolName = captured.firstCallTool || 'coordination_report';
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: toolName, arguments: '{"projectId":"p"}' } }],
        },
      },
    ],
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('POST /report streams grounded steps + a done event with deterministic citations', async (t) => {
  const captured = { openaiBodies: [], mcpToolCalls: [] };
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 7;

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(demoPort),
      HOST: '127.0.0.1',
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      SPECR_API_BASE: `http://127.0.0.1:${mockPort}`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill();
    mock.close();
  });

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

  // The write tool must never reach the model, and the internal __readOnly flag
  // must be stripped before hitting the OpenAI wire.
  const firstBody = captured.openaiBodies[0];
  const toolNames = (firstBody.tools || []).map((ttool) => ttool.function.name);
  assert.deepEqual(toolNames, ['coordination_report']);
  assert.ok(
    (firstBody.tools || []).every((tool) => !('__readOnly' in tool)),
    '__readOnly must not be sent to OpenAI'
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

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(demoPort),
      HOST: '127.0.0.1',
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      SPECR_API_BASE: `http://127.0.0.1:${mockPort}`,
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill();
    mock.close();
  });
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
