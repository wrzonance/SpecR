# MCP Server

> ↩ [Architecture index](../../ARCHITECTURE.md)

`src/mcp/server.ts` exports `registerMcpRoutes(app: Express)`. `POST /mcp` supports both transport modes. A stateless caller (no `mcp-session-id` header, non-`initialize` body) gets a fresh `McpServer` + stateless `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) per request, disposed on response finish. An `initialize` with no session header mints a stateful session: a transport with `sessionIdGenerator: () => randomUUID()` whose pair is held in an `McpSessionStore` (`src/mcp/sessions.ts`) keyed by the minted id and reused for every later request carrying that `mcp-session-id`. `registerTools(server)` and `registerResources(server)` wire all capabilities in both modes. `GET /mcp` returns 405 (SSE streaming not yet exposed). `DELETE /mcp` terminates the session named by `mcp-session-id` (400 if absent, 404 if unknown, 204 on success).

**Adding a tool** (inside `registerTools(server)` in `src/mcp/tools.ts`):

```typescript
server.registerTool('tool_name', {
  description: 'What this tool does for an AI agent.',
  inputSchema: { param: z.string().describe('param description') },
}, async ({ param }) => {
  try {
    const result = await someQuery(param);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool tool_name failed');
    return { isError: true, content: [{ type: 'text' as const, text: 'Internal error' }] };
  }
});
```

Rules: import DB functions from `../db/index.js` only (no internal query-file imports); use `z.uuid()` (Zod v4), not `z.string().uuid()`; always return `{ isError: true, content: [...] }` on error, never throw from a tool handler; extract handlers if a body exceeds the 50-line `max-lines-per-function` cap.

**Result anchors (`_meta['specr/anchors']`):** the four locate-oriented tools (`search_library`, `get_spec`, `get_references`, `coordination_report`) attach navigation anchors to their result's `_meta` under the key `specr/anchors`: an array of `{ section: string; specId?: string; paragraphId?: string }` derived purely from data already in the result (`src/mcp/anchors.ts`). The text `content` is unchanged, so text-only consumers are unaffected. UI clients (the `web_ui_demo` chat sidebar) use these to highlight the section(s) an answer is about in the active view. Attach with `anchorsMeta(anchors)`, which returns `undefined` for an empty list so no `_meta` is added. `_meta` is MCP's sanctioned channel for implementation metadata, chosen over a full `outputSchema`/`structuredContent` (disproportionate for tools like `get_spec` that return an entire tree).

**Adding a resource:**

```typescript
// Static URI:
server.registerResource('name', 'specr://path', { description: '...', mimeType: 'text/markdown' }, async (uri) => {
  return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: markdownString }] };
});
// Template URI:
server.registerResource('name', new ResourceTemplate('specr://path/{id}', { list: undefined }), { ... }, async (uri, { id }) => { ... });
```

**Stateful sessions (Phase 5h, #45):** implemented via `McpSessionStore` (`src/mcp/sessions.ts`), which owns the `Map<sessionId, { server, transport }>` and the session lifecycle (`createStateful`, `get`, `delete`). The SDK transport binds one session per instance, so a session is one long-lived transport+server pair keyed by the id the transport mints on `initialize`; the store registers/removes itself via the transport's `onsessioninitialized` / `onsessionclosed` callbacks. Tool/resource definitions are unchanged. **Auth hook:** the insertion point is marked in `server.ts`; add `Authorization: Bearer <token>` validation there in the same PR as REST auth.
