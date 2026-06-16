# MCP Stateful Sessions Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. TDD throughout.

**Goal:** Upgrade the MCP Streamable HTTP transport from stateless-only to optional stateful sessions, without breaking existing stateless clients.

**Architecture:** The `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` owns exactly one session per instance once `sessionIdGenerator` is set. So we maintain a `Map<sessionId, { server, transport }>` keyed by the session ID the transport mints on `initialize`. Routing on the `mcp-session-id` request header: (1) header matches a stored session → reuse it; (2) no header + `initialize` request → spin up a stateful transport that registers itself in the Map on init; (3) no header + non-initialize → fall back to a fresh stateless transport per request (the legacy path every existing client and test uses). `DELETE /mcp` with a valid session header closes that session's server+transport and removes the Map entry.

**Tech Stack:** TypeScript/Node 22, Express, `@modelcontextprotocol/sdk`, vitest.

---

## File Structure

- `src/mcp/sessions.ts` (new) — owns the `McpSessionStore` class: the `Map`, create-stateful, lookup, and delete/close logic. Keeps `server.ts` under the 400-line cap and isolates the session lifecycle (easy to unit-test the store cleanup contract).
- `src/mcp/server.ts` (modify) — Express route wiring delegates session decisions to the store; POST routes/reuses, DELETE terminates, GET 405 unless a live session SSE (kept as 405 stub — SSE GET streams are out of scope per issue: "no tool/resource changes", and Phase 5 streaming is a later slice).
- `src/mcp/server.integration.test.ts` (modify) — add session lifecycle integration tests.

---

## Task 1: Session store module

**Files:**
- Create: `src/mcp/sessions.ts`
- Test: covered by integration tests in `server.integration.test.ts` (the store is exercised end-to-end through HTTP; a pure unit test cannot meaningfully construct a real transport session without the full request flow).

- [ ] **Step 1:** Write `McpSessionStore` exposing `get(sessionId)`, `createStateful(makeServer)`, `delete(sessionId)`, `size()`. `createStateful` constructs a `StreamableHTTPServerTransport` with `sessionIdGenerator: () => randomUUID()` and `onsessioninitialized` storing `{ server, transport }` under the minted id; `onsessionclosed` removing it. Returns `{ server, transport }` for the caller to drive the request.
- [ ] **Step 2:** `delete(sessionId)` looks up the entry, calls `transport.close()` + `server.close()` (Promise.allSettled, log rejections), removes the Map entry. Returns boolean (found/not).

## Task 2: Wire stateful routing into POST /mcp

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1:** Instantiate one `McpSessionStore` in `registerMcpRoutes` scope.
- [ ] **Step 2:** POST handler: read `mcp-session-id` header. If present and store has it → reuse stored transport (do NOT close on finish). Else if no header and body is an `initialize` request → `store.createStateful(createMcpServer)`, drive request (no finish-cleanup; lifecycle owned by store). Else → existing stateless path (fresh transport, cleanup on finish).

## Task 3: DELETE /mcp termination

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1:** DELETE handler: read `mcp-session-id`. If missing → 400. If `store.delete(id)` false → 404. Else 204.

## Task 4: Integration tests

**Files:**
- Modify: `src/mcp/server.integration.test.ts`

- [ ] Same `mcp-session-id` from an `initialize` response routes a follow-up `tools/list` to the same server.
- [ ] DELETE with that session id returns 204 and removes it (subsequent reuse 404s at transport level).
- [ ] Stateless client (no session id, `tools/call`) still works — existing suite already covers this; add an explicit assertion that no `mcp-session-id` is returned for a stateless call.
- [ ] DELETE with no session header → 400; unknown session → 404.

## Task 5: Docs

- [ ] ARCHITECTURE.md: MCP section — note optional stateful sessions.
- [ ] docs/adr/010-mcp-server.md: Decision Update — implemented stateful sessions.
