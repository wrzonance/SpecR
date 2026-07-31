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

export function createMcpBridge(apiBase) {
  let requestId = 0;

  // One JSON-RPC round-trip to the SpecR MCP endpoint. The Streamable-HTTP
  // transport answers with either SSE (a `data:` line) or plain JSON; handle both.
  async function mcpRpc(method, params) {
    const res = await fetch(new URL('/mcp', apiBase), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    });
    const text = await res.text();
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
      return { text: text.slice(0, 8000), ok: result?.isError !== true, anchors };
    } catch (err) {
      return { text: `tool error: ${err.message}`, ok: false, anchors: [] };
    }
  }

  return { mcpRpc, listMcpTools, execToolCall };
}
