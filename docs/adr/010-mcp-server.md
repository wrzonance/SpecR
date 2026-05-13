# ADR-010: Expose MCP Server Alongside REST API

## Status: Accepted — implemented Phase 2a (2026-05-12)

## Context

MCP (Model Context Protocol) is Anthropic's open protocol for structured AI-tool interaction. An MCP server exposes **tools** (callable functions), **resources** (readable data), and **prompts** (reusable instructions) to AI assistants like Claude. MCP clients include Claude Code, Claude Desktop, and any MCP-compatible host.

SpecR's core value is a structured paragraph library with explicit hierarchy — exactly the kind of domain-specific knowledge that benefits from AI access. Today, a spec writer who wants AI assistance must copy-paste paragraphs from Word into a chat window, manually describe the structure, and copy the result back. MCP eliminates this entirely: the AI assistant calls SpecR tools directly, reads the library as structured data, and can reason about the full spec tree without manual mediation.

The REST API (ADR-002) already defines the capabilities. MCP is a second interface over the same service layer — not a separate system.

### What MCP unlocks for SpecR specifically

**Paragraph library search with semantic context.** An AI spec writer could ask "find all paragraphs about seismic bracing requirements in Division 27" and get structured `CsiNode` results back — not a full-text search dump, but a traversable tree fragment. This requires the library to be queryable by an AI, which MCP enables.

**AI-assisted merge conflict resolution.** When `POST /specs/:id/diff` returns a conflict, the spec writer can ask an AI to compare the base, theirs, and ours versions and recommend which to accept. The AI needs to read the conflict data directly — not have it pasted into a chat. An MCP resource exposing the diff result makes this a single tool call.

**Spec completeness and cross-reference checking.** A spec reviewer could ask Claude to verify that every referenced section number in Division 27 21 00 has a corresponding spec loaded in the database, or that Part 2 product paragraphs reference equipment that exists in Part 1 submittals. This requires reading multiple spec trees at once — a natural MCP multi-resource operation.

**Natural language library management.** "Add a new paragraph under Article 2.2 of spec 27 21 00 specifying cable management per TIA-568" — the AI calls `search_library` to find the right anchor, then calls a write tool with the new `CsiNode`. No web UI required for simple edits.

**Revit parameter mapping assistance.** When setting up Revit parameter → spec paragraph mappings (Phase 4), an AI assistant could browse the spec tree via MCP resources, identify the correct paragraph UUIDs, and generate the mapping configuration — a task that would otherwise require a developer to manually inspect the database.

## Decision

SpecR exposes an MCP server (`src/mcp/`) as a thin layer over the same service layer used by the REST API. Same PostgreSQL, same AST, same inference engine — different interface protocol.

### MCP Tools (callable functions)

```text
search_library(query, division?, section?, limit?)  → CsiNode[]
  Search paragraph library by text content and optional CSI filters.

get_spec(spec_id)                                   → CsiTree
  Return full spec tree as canonical CSI AST.

get_spec_diff(spec_id)                              → DiffResult
  Return pending diff (added/modified/deleted/conflicts) for a spec.

list_sections(division?)                            → CsiSection[]
  List CSI MasterFormat sections, optionally filtered by division.

get_paragraph(paragraph_id)                         → { node: CsiNode, ancestors: CsiNode[] }
  Return a paragraph with its full ancestor chain (for context).

parse_document(filename, content_base64)            → { spec_id, section, title, node_count }
  Upload and parse a DOCX or .SEC file.
```

### MCP Resources (readable data)

```text
specr://specs/{id}              → spec tree as Markdown (ADR-008 parallel output)
specr://specs/{id}/diff         → current diff as structured JSON
specr://library/{division}      → all specs in a division (summary list)
specr://library/{division}/{section}  → paragraph library for a section (Markdown)
specr://sections                → full CSI MasterFormat section index
```

Resources return **Markdown** as the primary format for LLM consumption. This is the first concrete reason to implement Markdown output (ADR-008) earlier than Phase 6 — MCP resources need it before the web UI does.

### MCP Prompts (reusable instructions)

```text
review_spec(spec_id)
  Loads the spec tree and provides a structured prompt for completeness review:
  cross-reference integrity, Part 1/2/3 balance, missing standard article types.

suggest_paragraphs(spec_id, article_id, context)
  Loads the current article content and library paragraphs for the section,
  provides a prompt for suggesting additional paragraphs.
```

## Consequences

- MCP server is a separate entry point (`src/mcp/server.ts`) using the `@modelcontextprotocol/sdk` package. It does NOT share the Express HTTP server — it runs as a stdio or SSE MCP server. (**Superseded — see Decision Update below.**)
- The service layer (`src/parser/`, `src/generator/`, `src/merge/`, `src/db/`) is called directly from both `src/api/` (REST) and `src/mcp/` (MCP). No duplication of business logic.
- **Markdown output becomes a Phase 2 priority**, not Phase 6. MCP resources that return raw JSON AST are technically correct but LLM-unfriendly. Markdown rendering of `CsiTree` is a prerequisite for useful MCP resources.
- The canonical AST (ADR-003) — especially the decision to store plain text without OOXML encoding — is what makes MCP viable. An LLM cannot reason about `<w:r><w:t>A.</w:t></w:r>` but can reason about `{ type: 'pr1', text: 'Manufacturer: Corning' }`.
- Authentication for MCP tools follows the same token-based auth as the REST API. The MCP server receives a bearer token in its initialization arguments and validates it against the same auth layer.
- MCP tool input validation uses the same Zod schemas as the REST API middleware — no separate validation layer.
- The MCP server is not in MVP (Phase 0–3). Its placement in Phase 2+ is because: (a) the service layer must be stable before adding a second interface, (b) Markdown output must exist first, (c) the library must have content worth searching before AI assistance adds value.

---

## Decision Update (Phase 2a, 2026-05-12)

**Original:** "It does NOT share the Express HTTP server — it runs as a stdio or SSE MCP server."

**Revised:** The MCP server IS integrated into the existing Express app via Streamable HTTP transport — same process, same port.

### What changed

`src/mcp/server.ts` exports `registerMcpRoutes(app)`, which mounts three routes on the Express instance:

```text
POST /mcp     ← MCP JSON-RPC requests (StreamableHTTPServerTransport)
GET  /mcp     ← 405 stub
DELETE /mcp   ← 405 stub
```

Each `POST /mcp` request creates a fresh `McpServer` instance with `StreamableHTTPServerTransport` configured as stateless (`sessionIdGenerator: undefined`). The McpServer calls `registerTools(server)` and `registerResources(server)` from `tools.ts` / `resources.ts`, then handles the request and disposes.

### Why

Streamable HTTP is the MCP spec's recommended transport for 2025+. It works identically for local clients (Claude Code, Claude Desktop) and remote clients — no different from the REST API's perspective. A separate stdio or SSE process would add operational complexity (process management, IPC, port coordination) with no benefit at this stage.

### Stateful session upgrade path (Phase 5+)

The stateless configuration is one parameter deep. When persistent sessions are needed (streaming tool progress, multi-turn tool state):

```typescript
// Stateless (current):
new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

// Stateful (Phase 5+):
new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
// + session Map<sessionId, McpServer> in the route handler
```

Tool and resource definitions in `tools.ts` / `resources.ts` are unchanged by this upgrade.

### Auth

No auth in Phase 2. A comment in `src/mcp/server.ts` marks the hook point. Auth will be added in the same PR as REST API auth (future phase).
