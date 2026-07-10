// Black-box integration test for the demo's Anthropic provider (issue #444).
// Spawns server.mjs as a child pointed at a mock Anthropic Messages endpoint
// and a mock SpecR MCP endpoint (one server plays both), then asserts /chat
// and /report end-to-end plus the wire-level translation contract. Run:
//   node --test examples/web_ui_demo/server.anthropic.test.mjs
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

// One mock plays the SpecR MCP endpoint (POST /mcp), the Anthropic Messages
// endpoint (POST /v1/messages), and a tripwire for the OpenAI path (which must
// never be hit while LLM_PROVIDER=anthropic).
function startMock(captured) {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mcp') return res.end(JSON.stringify(mcpResponse(body, captured)));
    if (req.url === '/v1/messages') {
      captured.anthropicBodies.push(body);
      captured.anthropicHeaders.push({
        'x-api-key': req.headers['x-api-key'],
        'anthropic-version': req.headers['anthropic-version'],
      });
      return res.end(JSON.stringify(anthropicResponse(body, captured)));
    }
    if (req.url.endsWith('/chat/completions')) {
      captured.openaiRequests += 1;
      return res.end('{"choices":[]}');
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
  return {
    jsonrpc: '2.0',
    id: body.id,
    result: {
      content: [{ type: 'text', text: '{"findings":[]}' }],
      _meta: { 'specr/anchors': [{ section: '03 30 00', specId: 's1', paragraphId: 'p1' }] },
    },
  };
}

function anthropicResponse(body, captured) {
  // The forced final turn disables tools with tool_choice:'none' — answer text.
  if (body.tool_choice?.type === 'none') {
    return {
      content: [{ type: 'text', text: 'Final: 03 30 00 has no coordination findings.' }],
      stop_reason: 'end_turn',
    };
  }
  const usedTool = body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
  );
  if (usedTool && !captured.alwaysToolUse) {
    return {
      content: [{ type: 'text', text: '03 30 00 has no coordination findings.' }],
      stop_reason: 'end_turn',
    };
  }
  return {
    content: [
      {
        type: 'tool_use',
        id: `c${captured.anthropicBodies.length}`,
        name: 'coordination_report',
        input: { projectId: 'p' },
      },
    ],
    stop_reason: 'tool_use',
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function spawnDemo(mockPort, demoPort, extraEnv = {}) {
  return spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(demoPort),
      HOST: '127.0.0.1',
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
      // A resident OpenAI key must NOT hijack the explicit provider choice.
      OPENAI_API_KEY: 'unused-openai-key',
      SPECR_API_BASE: `http://127.0.0.1:${mockPort}`,
      ...extraEnv,
    },
    stdio: 'ignore',
  });
}

async function stopDemo(child, mock) {
  child.kill();
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  mock.close();
}

async function waitForPort(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/`);
      if (probe.status) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`demo server did not come up on ${port}`);
}

function freshCaptured() {
  return { anthropicBodies: [], anthropicHeaders: [], mcpToolCalls: [], openaiRequests: 0 };
}

test('POST /chat answers via Anthropic with translated tools on the wire', async (t) => {
  const captured = freshCaptured();
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 21;
  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'any coordination issues in the project?' }],
    }),
  });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.provider, 'anthropic');
  assert.equal(body.data.model, 'claude-opus-4-8');
  assert.match(body.data.reply, /coordination findings/);
  assert.deepEqual(body.data.toolCalls, [{ name: 'coordination_report', ok: true }]);

  // Wire contract: Anthropic tool shape, no OpenAI wrapper, no internal flag.
  const first = captured.anthropicBodies[0];
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    ['coordination_report', 'create_project']
  );
  for (const tool of first.tools) {
    assert.ok('input_schema' in tool, 'tools must carry input_schema');
    assert.ok(!('function' in tool), 'OpenAI wrapper must not reach Anthropic');
    assert.ok(!('__readOnly' in tool), '__readOnly must not reach Anthropic');
  }
  assert.equal(typeof first.system, 'string');
  assert.match(first.system, /SpecR/);
  assert.equal(typeof first.max_tokens, 'number');
  assert.equal(captured.anthropicHeaders[0]['x-api-key'], 'test-key');
  assert.equal(captured.anthropicHeaders[0]['anthropic-version'], '2023-06-01');
  assert.equal(captured.openaiRequests, 0, 'OpenAI endpoint must never be called');
});

test('POST /chat round cap forces a final turn with tools + tool_choice none', async (t) => {
  const captured = freshCaptured();
  captured.alwaysToolUse = true; // model asks for a tool every round
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 22;
  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'loop forever' }] }),
  });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.match(body.data.reply, /^Final:/);

  // History with tool blocks REQUIRES a tools param — the final turn must send
  // the remembered tool list and forbid new calls via tool_choice none.
  const finalBody = captured.anthropicBodies[captured.anthropicBodies.length - 1];
  assert.deepEqual(finalBody.tool_choice, { type: 'none' });
  assert.ok(finalBody.tools.length > 0, 'final turn must still define tools');
  for (const earlier of captured.anthropicBodies.slice(0, -1)) {
    assert.ok(!('tool_choice' in earlier), 'normal rounds let the model decide');
  }
});

test('POST /report streams grounded steps and a done event via Anthropic', async (t) => {
  const captured = freshCaptured();
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 23;
  const child = spawnDemo(mockPort, demoPort);
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'coordination report for the active project' }),
  });
  assert.equal(res.status, 200);
  const events = (await res.text())
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));

  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'expected a done event');
  assert.equal(done.provider, 'anthropic');
  assert.equal(done.model, 'claude-opus-4-8');
  assert.match(done.reply, /coordination findings/);
  assert.deepEqual(done.citations, [{ section: '03 30 00', specId: 's1', paragraphId: 'p1' }]);
  assert.ok(
    events.some((e) => e.type === 'step' && e.tool === 'coordination_report' && e.status === 'done')
  );

  // Compose is read-only: the write tool must not be advertised to the model.
  assert.deepEqual(
    captured.anthropicBodies[0].tools.map((tool) => tool.name),
    ['coordination_report']
  );
});

test('missing ANTHROPIC_API_KEY degrades /chat with a provider-specific no-key reply', async (t) => {
  const captured = freshCaptured();
  const mock = startMock(captured);
  const mockPort = await listen(mock);
  const demoPort = 3000 + (process.pid % 500) + 24;
  const child = spawnDemo(mockPort, demoPort, { ANTHROPIC_API_KEY: '' });
  t.after(() => stopDemo(child, mock));
  await waitForPort(demoPort);

  const res = await fetch(`http://127.0.0.1:${demoPort}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.code, 'no-key');
  assert.match(body.error, /ANTHROPIC_API_KEY/);
  assert.equal(captured.anthropicBodies.length, 0);
});

test('an invalid LLM_PROVIDER exits at boot with code 1', async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(3000 + (process.pid % 500) + 25), LLM_PROVIDER: 'gemini' },
    stdio: 'ignore',
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
});
