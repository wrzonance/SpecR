// examples/web_ui_demo/mcp-bridge.mjs
// One JSON-RPC client for SpecR's stateless MCP endpoint (POST {apiBase}/mcp),
// shared by /chat and /report. `apiBase` is passed in explicitly (never read
// from process.env here) so this module has no import-time dependency on
// server.mjs's .env-loading order.

// Shape one MCP tool for the adapters. inputSchema is already JSON Schema on
// the wire. readOnly carries the server's readOnlyHint so /report can
// restrict its catalog to tools that cannot mutate state.
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

// A single MCP result is clamped before any consumer sees it, so one broad tool
// payload cannot blow the token budget or bloat a forced final compose turn.
// Truncation ALWAYS carries the marker: a silently shortened result produces a
// demo that looks fine and answers wrong, which is the failure mode this design
// rejects outright.
export const MAX_TOOL_RESULT_CHARS = 8000;
const TRUNCATION_MARK = '\n…[truncated ';

export function clampToolText(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  // Already clamped upstream. Re-clamping would slice the marker off and report
  // a wrong remainder, so the second guard (report-bridge) passes it through.
  if (s.startsWith(TRUNCATION_MARK, MAX_TOOL_RESULT_CHARS)) return s;
  return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}${TRUNCATION_MARK}${s.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

// `timeoutMs` bounds every MCP round-trip. Without it a wedged MCP endpoint
// holds the demo's /chat or /report request open forever — the provider calls
// are already bounded the same way (server.mjs).
export function createMcpBridge(apiBase, { timeoutMs = 60_000 } = {}) {
  let requestId = 0;

  // One JSON-RPC round-trip to the SpecR MCP endpoint. The Streamable-HTTP
  // transport answers with either SSE (a `data:` line) or plain JSON; handle both.
  async function mcpRpc(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetch(new URL('/mcp', apiBase), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
        signal: controller.signal,
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    // An HTTP-level failure (429 rate-limit / 5xx) carries the API's
    // {success:false, error} shape, not a JSON-RPC envelope — surface it as
    // an error instead of parsing it into a phantom "successful" tool result.
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

  // Discover every MCP tool. Used by both /chat and /report (the latter
  // narrows it with filterReadOnlyTools before building a session).
  async function listMcpTools() {
    const result = await mcpRpc('tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map(toMcpTool);
  }

  // Execute one session-shaped tool call ({id, name, args}) against MCP;
  // return the text result (truncated) and whether it succeeded. Never
  // throws — a failed tool becomes a tool result the model can react to.
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
      return { text: clampToolText(text), ok: result?.isError !== true, anchors };
    } catch (err) {
      return { text: `tool error: ${err.message}`, ok: false, anchors: [] };
    }
  }

  return { mcpRpc, listMcpTools, execToolCall };
}
