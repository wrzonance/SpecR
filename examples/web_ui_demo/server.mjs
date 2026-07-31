import { createReadStream, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { runReport } from './report-bridge.mjs';
import { createSession, CHAT_CORE_TOOLS } from './providers/index.mjs';
import { runChat } from './chat-loop.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Load a local .env sitting next to this server (examples/web_ui_demo/.env) so
// the demo is configured from its own folder — LLM provider key, model, ports —
// rather than the repo root. A missing .env is fine (the defaults below apply); a
// real shell/CI environment variable always wins over a value set in the file, so
// the one-command launchers (which pass PORT/SPECR_API_BASE inline) keep control
// of the ports while .env supplies the LLM provider settings.
function loadLocalEnv(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false; // no local .env — rely on the real environment + defaults
  }
  for (const [key, value] of Object.entries(parseEnv(raw))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
const ENV_FILE = join(ROOT, '.env');
const ENV_LOADED = loadLocalEnv(ENV_FILE);

const PORT = Number.parseInt(process.env.PORT || '3001', 10);
// Bind address. Defaults to loopback so the demo stays private to this machine;
// set HOST=0.0.0.0 to reach it from other machines on your LAN. That also exposes
// the proxied SpecR API and the LLM-backed /chat endpoint, so only opt in on a
// network you trust.
const HOST = process.env.HOST || '127.0.0.1';
const API_BASE = process.env.SPECR_API_BASE || 'http://127.0.0.1:3000';

// LLM chat bridge config — the demo speaks to exactly ONE provider, chosen
// explicitly by LLM_PROVIDER (keys alone never switch it). Keys live ONLY here
// (server-side); the browser never sees them. A missing key for the selected
// provider ⇒ /chat and /report degrade to a clear "not configured" reply.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
if (LLM_PROVIDER !== 'openai' && LLM_PROVIDER !== 'anthropic') {
  console.error(
    `SpecR demo: invalid LLM_PROVIDER "${process.env.LLM_PROVIDER}" — use "openai" or "anthropic".`
  );
  process.exit(1);
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
// Tool search (progressive tool discovery) requires the Responses API and a
// gpt-5.4+ model; the demo's 131-tool MCP catalog does not fit without it.
// gpt-5.6-luna is the cheapest tier clearing that floor.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// No /v1 suffix here — the adapter appends /v1/messages. Trailing slashes are
// stripped so a gateway URL like "https://proxy/anthropic/" cannot yield a
// "//v1/messages" path.
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(
  /\/+$/,
  ''
);
// Tool search requires Sonnet 4.5 / Opus 4.5 or newer.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 16_000; // Messages API requires max_tokens; ample for concise replies
const CHAT_MAX_TOOL_ROUNDS = 8; // +2 over the pre-discovery cap: a search can cost a round
const CHAT_MAX_MESSAGES = 40; // reject oversized histories

// Grounded-reporting loop guardrails (#353). A report composes several grounded
// tool calls, so it gets a wider budget than free-form chat — but still bounded so
// the "hundreds of DOCX" corpus case cannot run away on cost.
const REPORT_MAX_ROUNDS = 8;
const REPORT_MAX_TOOL_CALLS = 12;
const REPORT_TOKEN_BUDGET = 120_000;
const REPORT_MAX_REQUEST_CHARS = 4000;
// Hard byte cap on the /report request body, enforced DURING accumulation so an
// oversized payload is rejected before it is fully buffered (the request string
// caps at 4000 chars; 16 KiB leaves ample room for the JSON envelope + scope).
const REPORT_MAX_BODY_BYTES = 16 * 1024;

const API_PREFIXES = [
  '/health',
  '/specs',
  '/parse',
  '/projects',
  '/libraries',
  '/packages',
  '/revisions',
  '/templates',
  '/numbering-profiles',
  '/reports',
  '/mcp',
];

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

// Explicit, lockfile-pinned vendor allowlist. Each entry maps an EXACT request path
// to an EXACT file resolved out of node_modules — the request path is only ever a Map
// key, never joined into a filesystem path, so there is no traversal surface. markdown-it
// ships no single-file ESM bundle (its ESM entry is a multi-file graph), so we serve its
// self-contained UMD bundle, which sets window.markdownit for the browser (see index.html).
const require = createRequire(import.meta.url);
function resolveVendor(specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return null; // not installed — the /vendor route 404s and the renderer degrades safely
  }
}
const VENDOR_ROUTES = new Map(
  [
    ['/vendor/markdown-it.min.js', resolveVendor('markdown-it/dist/markdown-it.min.js')],
    ['/vendor/markdown-it.min.js.map', resolveVendor('markdown-it/dist/markdown-it.min.js.map')],
  ].filter(([, file]) => file !== null)
);

function serveVendor(res, file) {
  const mime = MIME_TYPES.get(extname(file)) || 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=3600' });
  createReadStream(file).pipe(res);
}

function isApiPath(pathname) {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

// Like readRequestBody, but stops accumulating and throws once `maxBytes` is
// crossed — so an oversized body can't be fully buffered into memory before it
// is rejected. Used by /report (small JSON envelopes only).
async function readBoundedBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function proxyHeaders(req, body) {
  const headers = new Headers(req.headers);
  headers.delete('connection');
  headers.delete('host');
  headers.delete('content-length');
  if (body) headers.set('content-length', String(body.byteLength));
  return headers;
}

async function proxyApi(req, res, url) {
  try {
    const body =
      req.method === 'GET' || req.method === 'HEAD' ? undefined : await readRequestBody(req);
    const upstream = await fetch(new URL(`${url.pathname}${url.search}`, API_BASE), {
      method: req.method,
      headers: proxyHeaders(req, body),
      body,
    });
    const headers = Object.fromEntries(upstream.headers);
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    res.writeHead(upstream.status, headers);
    const payload = Buffer.from(await upstream.arrayBuffer());
    res.end(payload);
  } catch (err) {
    sendJson(res, 502, {
      success: false,
      error: `demo proxy could not reach SpecR API at ${API_BASE}: ${err.message}`,
    });
  }
}

async function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    // decodeURIComponent throws URIError on malformed escapes (e.g. "%ZZ").
    sendJson(res, 400, { success: false, error: 'malformed request path' });
    return;
  }
  const resolved = resolve(ROOT, `.${pathname}`);
  const rootWithSep = ROOT.endsWith(sep) ? ROOT : `${ROOT}${sep}`;
  if (!resolved.startsWith(rootWithSep)) {
    sendJson(res, 403, { success: false, error: 'forbidden' });
    return;
  }

  try {
    const stats = statSync(resolved);
    const file = stats.isDirectory() ? join(resolved, 'index.html') : resolved;
    const mime = MIME_TYPES.get(extname(file)) || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    createReadStream(file).pipe(res);
  } catch {
    const fallback = await readFile(join(ROOT, 'index.html'), 'utf8');
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fallback);
  }
}

// ── LLM ⇄ MCP chat bridge ─────────────────────────────────────────────────
// The browser POSTs its conversation to /chat. We run the active provider's
// chat loop (OpenAI or Anthropic) with tool-calling, and every tool call the
// model makes is executed against SpecR's stateless MCP endpoint (POST {API_BASE}/mcp).
// The key never leaves this process. MVP: non-streaming, read-and-write MCP tools as SpecR exposes.

const SYSTEM_PROMPT = [
  'You are the SpecR assistant, embedded in a CSI MasterFormat specification tool.',
  'Answer questions about the specs, projects, and libraries the user has loaded by',
  'calling the provided MCP tools — never invent spec content, section numbers, or IDs.',
  'Most tools need UUIDs: discover them first with list_projects, list_sections, or',
  'search_library, then call the specific tool. Cross-references need a projectId.',
  'Keep answers concise and cite section numbers (e.g. "09 22 00") where relevant.',
  'If a tool returns an error or empty result, say so plainly rather than guessing.',
  'Most tools are discovered on demand — search for them by capability. Categories:',
  'projects, specs and paragraphs, packages and issued revisions, headers/footers,',
  'language rules, coordination and reporting, templates and numbering profiles.',
].join(' ');

let mcpRequestId = 0;

// One JSON-RPC round-trip to the SpecR MCP endpoint. The Streamable-HTTP
// transport answers with either SSE (a `data:` line) or plain JSON; handle both.
async function mcpRpc(method, params) {
  const res = await fetch(new URL('/mcp', API_BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpRequestId, method, params }),
  });
  const text = await res.text();
  // An HTTP-level failure (429 rate-limit / 5xx) carries the API's {success:false,
  // error} shape, not a JSON-RPC envelope — surface it as an error instead of
  // parsing it into a phantom "successful" (no-content) tool result.
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('text/event-stream')
    ? (text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? '{}')
    : text;
  const parsed = JSON.parse(payload);
  if (parsed.error) throw new Error(parsed.error.message || 'MCP error');
  if (!('result' in parsed)) throw new Error('MCP response missing result');
  return parsed.result;
}

// Shape one MCP tool for the adapters. inputSchema is already JSON Schema on the
// wire. readOnly carries the server's readOnlyHint so /report can restrict its
// catalog to tools that cannot mutate state.
function toMcpTool(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema:
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

// Discover every MCP tool. Used by both /chat and /report (the latter narrows
// it with filterReadOnlyTools before building a session).
async function listMcpTools() {
  const result = await mcpRpc('tools/list', {});
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools.map(toMcpTool);
}

// Execute one session-shaped tool call ({id, name, args}) against MCP; return
// the text result (truncated) and whether it succeeded. Never throws — a
// failed tool becomes a tool result the model can react to.
async function execToolCall(call) {
  try {
    const result = await mcpRpc('tools/call', { name: call.name, arguments: call.args });
    const text =
      (result?.content || [])
        .map((part) => part.text)
        .filter(Boolean)
        .join('\n') || '(no content)';
    const raw = result?._meta?.['specr/anchors'];
    const anchors = Array.isArray(raw) ? raw : [];
    return { text: text.slice(0, 8000), ok: result?.isError !== true, anchors };
  } catch (err) {
    return { text: `tool error: ${err.message}`, ok: false, anchors: [] };
  }
}

// The single active provider, resolved once at boot from LLM_PROVIDER. Each
// entry's `config` is createSession's config param verbatim.
const PROVIDERS = {
  openai: {
    name: 'openai',
    model: OPENAI_MODEL,
    keyName: 'OPENAI_API_KEY',
    hasKey: OPENAI_API_KEY !== '',
    config: { model: OPENAI_MODEL, apiKey: OPENAI_API_KEY, baseUrl: OPENAI_BASE, timeoutMs: 60_000 },
  },
  anthropic: {
    name: 'anthropic',
    model: ANTHROPIC_MODEL,
    keyName: 'ANTHROPIC_API_KEY',
    hasKey: ANTHROPIC_API_KEY !== '',
    config: {
      model: ANTHROPIC_MODEL,
      apiKey: ANTHROPIC_API_KEY,
      baseUrl: ANTHROPIC_BASE,
      version: ANTHROPIC_VERSION,
      maxTokens: ANTHROPIC_MAX_TOKENS,
      timeoutMs: 60_000,
    },
  },
};
const PROVIDER = PROVIDERS[LLM_PROVIDER];

// Keep only well-formed user/assistant turns with string content, length-capped.
function sanitizeMessages(messages) {
  const clean = [];
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    clean.push({ role, content: message.content.slice(0, 4000) });
  }
  return clean;
}

async function handleChat(req, res) {
  if (!PROVIDER.hasKey) {
    sendJson(res, 200, {
      success: false,
      code: 'no-key',
      error: `${PROVIDER.keyName} not configured on the demo server`,
    });
    return;
  }
  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw.toString('utf8')) : null;
  } catch {
    sendJson(res, 400, { success: false, error: 'invalid JSON body' });
    return;
  }
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    sendJson(res, 400, { success: false, error: 'messages[] required' });
    return;
  }
  if (messages.length > CHAT_MAX_MESSAGES) {
    sendJson(res, 400, { success: false, error: 'conversation too long' });
    return;
  }
  const clean = sanitizeMessages(messages);
  if (clean.length === 0) {
    sendJson(res, 400, { success: false, error: 'no valid messages' });
    return;
  }
  try {
    const catalog = await listMcpTools();
    const session = createSession({
      provider: PROVIDER.name,
      system: SYSTEM_PROMPT,
      userMessages: clean,
      catalog,
      coreToolNames: CHAT_CORE_TOOLS,
      config: PROVIDER.config,
    });
    const { reply, toolCalls, focus } = await runChat({
      session,
      execTool: execToolCall,
      maxRounds: CHAT_MAX_TOOL_ROUNDS,
    });
    sendJson(res, 200, {
      success: true,
      data: { reply, toolCalls, focus, provider: PROVIDER.name, model: PROVIDER.model },
    });
  } catch (err) {
    sendJson(res, 502, {
      success: false,
      code: err.code ?? null,
      error: err.message,
      detail: err.detail ?? '',
    });
  }
}

// ── Grounded reporting bridge (#353) ────────────────────────────────────────
// POST /report streams the agent's tool-calling steps live as newline-delimited
// JSON (one object per line: step | usage | done | error). It reuses the same
// MCP + LLM plumbing as /chat, but hands the model only read-only tools — the
// composer cannot mutate state, and every citation traces to a real paragraph.

function reportEmitter(res) {
  return (obj) => res.write(`${JSON.stringify(obj)}\n`);
}

function parseReportRequest(payload) {
  const request = payload?.request;
  if (typeof request !== 'string' || request.trim() === '')
    return { error: 'request text required' };
  if (request.length > REPORT_MAX_REQUEST_CHARS) return { error: 'request too long' };
  const rawLabel = payload?.scope?.label;
  const scope =
    typeof rawLabel === 'string' && rawLabel.trim() !== '' ? { label: rawLabel } : undefined;
  return { request, scope };
}

async function handleReport(req, res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const emit = reportEmitter(res);
  if (!PROVIDER.hasKey) {
    emit({
      type: 'error',
      code: 'no-key',
      error: `${PROVIDER.keyName} not configured on the demo server`,
    });
    res.end();
    return;
  }
  let payload;
  try {
    const raw = await readBoundedBody(req, REPORT_MAX_BODY_BYTES);
    payload = raw ? JSON.parse(raw.toString('utf8')) : null;
  } catch (err) {
    const message = err?.code === 'BODY_TOO_LARGE' ? 'request body too large' : 'invalid JSON body';
    emit({ type: 'error', error: message });
    res.end();
    return;
  }
  const { request, scope, error } = parseReportRequest(payload);
  if (error) {
    emit({ type: 'error', error });
    res.end();
    return;
  }
  try {
    const result = await runReport({
      request,
      scope,
      emit,
      limits: {
        maxRounds: REPORT_MAX_ROUNDS,
        maxToolCalls: REPORT_MAX_TOOL_CALLS,
        tokenBudget: REPORT_TOKEN_BUDGET,
      },
      deps: {
        listTools: listMcpTools,
        createSession: (opts) => createSession({ ...opts, provider: PROVIDER.name, config: PROVIDER.config }),
        execTool: execToolCall,
      },
    });
    emit({ type: 'done', ...result, provider: PROVIDER.name, model: PROVIDER.model });
  } catch (err) {
    emit({ type: 'error', error: `report failed: ${err.message}` });
  } finally {
    res.end();
  }
}

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname === '/report') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { success: false, error: 'POST only' });
      return;
    }
    void handleReport(req, res);
    return;
  }
  if (url.pathname === '/chat') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { success: false, error: 'POST only' });
      return;
    }
    void handleChat(req, res);
    return;
  }
  const vendorFile = VENDOR_ROUTES.get(url.pathname);
  if (vendorFile) {
    serveVendor(res, vendorFile);
    return;
  }
  if (isApiPath(url.pathname)) {
    void proxyApi(req, res, url);
    return;
  }
  void serveStatic(req, res, url);
}).listen(PORT, HOST, () => {
  const lanExposed = HOST === '0.0.0.0' || HOST === '::';
  const shown = lanExposed
    ? `bound to ${HOST}:${PORT} — reachable from other machines on your network`
    : `http://${HOST}:${PORT}`;
  console.log(`SpecR web UI demo: ${shown}`);
  console.log(`Proxying API calls to: ${API_BASE}`);
  console.log(
    `Config: ${ENV_LOADED ? `loaded ${ENV_FILE}` : `no .env at ${ENV_FILE} (using defaults + real env)`}`
  );
  console.log(
    `Chat bridge: ${
      PROVIDER.hasKey
        ? `enabled (${PROVIDER.name}, model ${PROVIDER.model})`
        : `disabled (set ${PROVIDER.keyName} in .env)`
    }`
  );
});
