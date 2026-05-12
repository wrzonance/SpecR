# MCP Server Design — Phase 2a

**Date:** 2026-05-11  
**Status:** Approved  
**Scope:** Phase 2a core read-only MCP surface + Markdown renderer

---

## Context

SpecR exposes a structured paragraph library with explicit CSI hierarchy. MCP (Model Context Protocol) gives AI assistants (Claude Code, Claude Desktop) direct access to that library — searching paragraphs, reading spec trees, checking what sections are loaded — without manual copy-paste.

This design covers Phase 2a only: a **read-only, stateless MCP server** integrated into the existing Express app. Write tools and stateful sessions are explicitly deferred.

---

## Transport: Stateless Streamable HTTP

MCP server is **not** a separate process. It mounts onto the existing Express app as a route group. Uses `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`).

All Phase 2a tools are read-only queries — no streaming, no cross-call state. Stateless is correct.

**Upgrade path to stateful sessions (Phase 5+):** Change `sessionIdGenerator: undefined` to `sessionIdGenerator: () => randomUUID()` and add a `Map<sessionId, transport>` in the route handler. Tool and resource definitions are unchanged.

**Route surface added to Express:**

```text
POST   /mcp   — all MCP requests (JSON-RPC over Streamable HTTP)
GET    /mcp   — SSE stream for server-push (stub in Phase 2, used in stateful sessions)
DELETE /mcp   — session teardown (stub in Phase 2)
```

**Local use (Claude Code):** configure `http://localhost:3000/mcp` as the MCP server URL.  
**Remote use (Claude Desktop):** same URL on the hosted server.

---

## File Layout

```text
src/
├── mcp/
│   ├── server.ts      # creates McpServer, registers tools+resources, exports registerMcpRoutes()
│   ├── tools.ts       # handlers: search_library, get_spec, list_sections
│   └── resources.ts   # handlers: specr://specs/{id}, specr://sections
├── generator/
│   └── markdown.ts    # CsiTree → Markdown (new — shared with MCP resources and future DOCX generator)
└── index.ts           # calls registerMcpRoutes(app) alongside existing REST routes
```

`tools.ts` and `resources.ts` import directly from `src/db/queries/` — same path as REST API handlers. No new service abstraction layer.

---

## Authentication

**Phase 2: none.** MCP endpoint is open, same as the rest of the API today.

**Auth hook point** (future — same PR as REST auth):

```typescript
// src/mcp/server.ts — route handler
app.post('/mcp', async (req, res) => {
  // AUTH HOOK: validate Authorization: Bearer <token> here before transport.handleRequest()
  // Same token validation as REST middleware. Reject 401 if invalid.
  // Write tools especially depend on this gate.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

Single insertion point — zero changes to tool handlers when auth is added.

---

## Tools

### `search_library(query, division?, limit?)`

Search paragraph library by text content.

- **Input:** `{ query: string, division?: string, limit?: number (default 20) }`
- **Query:** `ILIKE '%query%'` on `paragraphs.text`, optional `WHERE specs.section LIKE 'XX %'` for division filter
- **Returns:** `{ paragraphId, text, nodeType, specId, specSection, specTitle }[]`
- **Future:** upgrade `ILIKE` to `to_tsvector` full-text search in Phase 6

**Example use:** "find all paragraphs about seismic bracing in Division 27" → `search_library("seismic bracing", "27")`

---

### `get_spec(specId)`

Return full spec tree with cross-reference data.

- **Input:** `{ specId: string (UUID) }`
- **Query:** existing recursive CTE → `CsiTree` + JOIN on `spec_references` for this spec
- **Returns:**
  ```typescript
  {
    tree: CsiTree,
    references: {
      referenceText: string,        // verbatim text from source paragraph
      targetSection: string,        // e.g. "01 45 00"
      targetSpecId: string | null,  // resolved UUID, null = not in DB
      isResolved: boolean,
      isBroken: boolean
    }[]
  }
  ```

**Key use case:** "Is there a paragraph in the fiber optic spec that references the testing spec, and does that spec exist in the database?" → `search_library("fiber optic backbone")` to find specId, then `get_spec(id)` returns tree + reference list. Claude sees `targetSpecId: null` → spec not loaded.

---

### `list_sections(division?)`

List CSI MasterFormat sections with loaded status.

- **Input:** `{ division?: string }`
- **Query:** `csi_sections` LEFT JOIN `specs` on section number
- **Returns:** `{ section, title, division, inDatabase: boolean }[]`

**Example use:** "What Division 27 specs are missing from my library?" → `list_sections("27")`, filter `inDatabase: false`.

---

## Resources

### `specr://specs/{id}`

Full spec as LLM-readable Markdown. Calls `generator/markdown.ts` renderer.

**Rendered format:**

```markdown
# SECTION 27 21 00 — STRUCTURED CABLING FOR TELECOMMUNICATIONS

## PART 1 - GENERAL

### 1.1 REFERENCES

A. Coordinate work of all trades.

> **[NOTE]** Edit this paragraph to reflect local seismic zone requirements.

B. Submit shop drawings per Section 01 33 00.
   1. Include cable routing plans.
      a. Show all penetrations.
```

Node type → rendering:

| Node type    | Markdown                          |
|--------------|-----------------------------------|
| `part`       | `## PART N - TITLE`               |
| `article`    | `### N.N TITLE`                   |
| `pr1`        | `A. text` (lettered per siblings) |
| `pr2`        | `1. text` (3-space indent)        |
| `pr3`        | `a. text` (6-space indent)        |
| `pr4`        | `1) text` (9-space indent)        |
| `pr5`        | `a) text` (12-space indent)       |
| `continuation` | plain paragraph, no label       |
| `vanish`     | `> **[NOTE]** text` (blockquote)  |

Vanish nodes (specifier notes) are **included** — they carry editor instructions and owner comments that provide essential context for AI-assisted spec review.

---

### `specr://sections`

Full CSI section index with loaded status.

```markdown
| Section   | Title                                          | In DB |
|-----------|------------------------------------------------|-------|
| 27 21 00  | Structured Cabling for Telecommunications      | ✓     |
| 27 51 16  | Public Address Systems                         |       |
```

Single query: `csi_sections` LEFT JOIN `specs`. Claude can immediately identify library gaps.

---

## Markdown Renderer (`src/generator/markdown.ts`)

Pure function: `renderMarkdown(tree: CsiTree): string`

- Walks `CsiTree` recursively
- Tracks sibling index per parent to assign CSI labels (A/B/C for pr1, 1/2/3 for pr2, etc.)
- No I/O, no DB calls — fully unit-testable with fixture input
- **Shared with DOCX generator** — the numbering label logic (`getLabel(type, index)`) is extracted as a pure helper. The DOCX generator (Phase 2a) imports `getLabel` rather than reimplementing it.

---

## Error Handling

Tool errors return MCP-structured errors, not HTTP errors:

```typescript
// Known error (spec not found, bad input):
return { isError: true, content: [{ type: "text", text: "Spec not found: id=abc123" }] }

// Unexpected error (DB down):
logger.error({ err }, 'MCP tool error: get_spec');
return { isError: true, content: [{ type: "text", text: "Internal error — see server logs" }] }
```

- Stack traces never leave the process
- Zod validation on all tool inputs — same schemas as REST middleware, no duplication
- Zod failures return `isError: true` with the field-level message before hitting the DB

---

## Testing

**Unit tests (no DB):**
- `markdown.ts`: `CsiTree` fixtures → expected Markdown string (pure function, deterministic)
- Edge cases: empty parts, vanish-only sections, continuation runs, ilvl gaps

**Integration tests (requires PostgreSQL):**
- Mount Express app, send JSON-RPC requests to `POST /mcp`
- `search_library`: known query → expected paragraph results
- `get_spec`: known spec ID → tree shape + reference resolution status
- `list_sections`: verify `inDatabase` flag accuracy

No MCP client binary required for tests — it's plain HTTP POST with a JSON-RPC body.

---

## What This Enables (Phase 2a)

| User asks Claude | Tools called | Answer |
|------------------|-------------|--------|
| "What Division 27 specs are loaded?" | `list_sections("27")` | Table with ✓ markers |
| "Find paragraphs about fiber optic testing" | `search_library("fiber optic testing")` | Matching paragraphs with spec context |
| "Does the fiber optic spec reference a testing spec, and is it loaded?" | `search_library` → `get_spec` | Yes/no with broken reference flag |
| "Show me Section 27 21 00 in full" | `specr://specs/{id}` resource | Full Markdown spec tree |

---

## Deferred to Later Phases

| Item | Phase |
|------|-------|
| `get_paragraph(id)` tool — paragraph + ancestor chain | 2b follow-up PR |
| `parse_document` tool — upload DOCX/SEC via MCP | 2b follow-up PR |
| `specr://library/{division}` and `specr://library/{division}/{section}` resources | 2b follow-up PR |
| Write tools (`add_paragraph`, `update_paragraph`, etc.) | Phase 5 |
| Stateful sessions (session map, reconnection) | Phase 5 |
| `review_spec`, `suggest_paragraphs` prompts | Phase 6 |
| `get_spec_diff` tool, `specr://specs/{id}/diff` resource | Phase 3 (needs merge engine) |
| Full-text search upgrade (`to_tsvector`) | Phase 6 |
| Authentication | Same PR as REST auth |
