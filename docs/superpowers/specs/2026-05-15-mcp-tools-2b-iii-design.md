# Design: Phase 2b-iii — MCP Tools (`get_paragraph`, `parse_document`, `generate_docx`)

**Date:** 2026-05-15
**Issues:** #29 (get_paragraph + parse_document), bundled with generate_docx (referenced ARCHITECTURE.md Phase 2b)
**Branch:** `feat/mcp-tools-2b-iii`
**Milestone:** Phase 2b
**Blocked by:** Nothing (Phase 2b-ii merged — PR #51)
**Critical path:** Completes Phase 2b milestone → Phase 3 merge engine (#34) unblocked

---

## Scope

Three new MCP tools added to `src/mcp/tools.ts`. One new DB query function. Module boundary for `mcp/` expands to include `parser/` and `generator/`. No new files.

**In scope:**
- `get_paragraph` — per-paragraph context with full ancestor chain
- `parse_document` — upload and parse DOCX/SEC directly via MCP (base64 encoded)
- `generate_docx` — generate DOCX from stored spec, return as base64
- Integration tests for all three tools
- README.md + ARCHITECTURE.md + CLAUDE.md doc updates (closing issue #29)

**Out of scope:**
- MCP write tools (`add_paragraph`, `update_paragraph`, `delete_paragraph`) — Phase 5
- MCP stateful sessions — Phase 5+
- MCP prompts (`review_spec`, `suggest_paragraphs`) — Phase 6
- DOCX caching layer — Phase 6 (tracked as separate GitHub issue)
- Style template wiring in `generate_docx` — Phase 2c (#32)

---

## Architecture

### Approach: Extend `tools.ts` in place (Approach A)

Three handlers added following existing extracted-handler pattern. No new files. `tools.ts` stays under 400-line ESLint limit with handlers extracted per function.

### Module boundary update

Current: `mcp/ ← imports from db/index.ts and generator/markdown.ts only`

New: `mcp/ ← imports from db/index.ts, generator/index.ts, parser/index.ts — no api/ internals`

Updated in `CLAUDE.md` and `ARCHITECTURE.md`. Rationale: Phase 2b-iii adds write (parse_document) and generation (generate_docx) tools that naturally require parser and generator modules directly.

---

## Files Changed

| File | Change |
|------|--------|
| `src/db/queries/paragraphs.ts` | Add `ParagraphRow`, `ParagraphWithAncestors` interfaces + `getParagraphWithAncestors(id)` |
| `src/db/index.ts` | Re-export new function + types |
| `src/mcp/tools.ts` | 3 new handlers + 3 `registerTool` calls; new imports |
| `src/mcp/server.integration.test.ts` | 7 new test cases across 3 tool suites |
| `README.md` | Status table: 2b-iii ✅; MCP section; remove from "Not Yet Built" |
| `ARCHITECTURE.md` | Phase 2b-iii status; MCP tools list; module boundary; Phase 6 cache note |
| `CLAUDE.md` | MCP module boundary line |

---

## Section 1: DB Layer

**File:** `src/db/queries/paragraphs.ts`

**New exports:**

```typescript
export interface ParagraphRow {
  readonly id: string;
  readonly nodeType: string;
  readonly text: string;
  readonly vanish: boolean;
}

export interface ParagraphWithAncestors {
  readonly node: ParagraphRow;
  readonly ancestors: readonly ParagraphRow[];  // ordered root → immediate parent
}

export async function getParagraphWithAncestors(
  id: string
): Promise<ParagraphWithAncestors | null>
```

**SQL:** Recursive CTE walks `parent_id` chain upward from the given paragraph UUID. Returns all rows ordered `depth DESC` (root first, queried paragraph last at `depth=0`). Null result when UUID not found.

```sql
WITH RECURSIVE chain AS (
  SELECT id, node_type, text, vanish, parent_id, 0 AS depth
  FROM paragraphs WHERE id = $1
  UNION ALL
  SELECT p.id, p.node_type, p.text, p.vanish, p.parent_id, c.depth + 1
  FROM paragraphs p JOIN chain c ON p.id = c.parent_id
)
SELECT id, node_type AS "nodeType", text, vanish, depth
FROM chain ORDER BY depth DESC
```

**Pool access:** Import `pool` from `'../index.js'` (same circular-dep pattern as `search.ts` — works via Node ESM live bindings).

**`db/index.ts`:** Re-export `getParagraphWithAncestors`, `ParagraphRow`, `ParagraphWithAncestors`.

---

## Section 2: `get_paragraph` Tool

**Input schema:**
```typescript
{ paragraphId: z.uuid().describe('Paragraph UUID (from search_library or get_spec)') }
```

**Handler:** `handleGetParagraph`

**Logic:**
1. Call `getParagraphWithAncestors(paragraphId)`
2. If `null` → return `{ isError: true, content: [{ type: 'text', text: 'Paragraph not found: id=...' }] }`
3. Return `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`

**Output shape:**
```json
{
  "node": { "id": "uuid", "nodeType": "pr1", "text": "Provide fiber optic...", "vanish": false },
  "ancestors": [
    { "id": "uuid", "nodeType": "part",    "text": "GENERAL", "vanish": false },
    { "id": "uuid", "nodeType": "article", "text": "SCOPE",   "vanish": false }
  ]
}
```

**Tool description:** `"Return a single paragraph with its full ancestor chain (root to immediate parent). Use to get context around a search_library result."`

---

## Section 3: `parse_document` Tool

**Input schema:**
```typescript
{
  filename: z.string().describe('Original filename — extension determines format (.docx or .sec)'),
  contentBase64: z.string().describe('Base64-encoded file content (max 10 MB decoded)')
}
```

**Handler:** `handleParseDocument`

**Validation chain (fail fast → `isError: true` on any failure):**

1. Extract extension from `filename` — must be `.docx` or `.sec`
2. Size pre-check: `Math.ceil(contentBase64.length * 3 / 4) > 10 * 1024 * 1024` → reject
3. Decode: `Buffer.from(contentBase64, 'base64')`
4. Safety: `assertDocxSafe(buf)` or `assertSecSafe(buf)`
5. Parse: `parseDocx(buf, noopProgress)` or `parseSec(buf.toString('utf-8')).tree`
6. Persist: same transaction pattern as `api/parse.ts:persistTree` — `BEGIN`, `createSpec`, `insertTree`, `COMMIT`; `ROLLBACK` on error
7. Count nodes via `countNodes(tree.parts)` (recursive reduce, inline helper)
8. Return `{ specId, section, title, nodeCount }`

**Output shape:**
```json
{ "specId": "uuid", "section": "27 21 00", "title": "Structured Cabling", "nodeCount": 142 }
```

**Note on synchronous blocking:** `parseDocx` takes 1–3s on large files. MCP stateless mode has no polling mechanism, so tool blocks until done. The 10 MB size limit mitigates worst-case latency. Async-with-polling deferred to stateful session upgrade (Phase 5+).

**Tool description:** `"Parse a DOCX or SEC specification file and store it in the database. Pass the file content as base64. Returns the new spec ID and summary. Note: computation-intensive for large DOCX files."`

---

## Section 4: `generate_docx` Tool

**Input schema:**
```typescript
{ specId: z.uuid().describe('Spec UUID to generate DOCX for') }
```

**Handler:** `handleGenerateDocx`

**Logic:**
1. `getSpecTree(specId)` → null → `isError: true, 'Spec not found: id=...'`
2. `generateDocx(result.tree)` → `Buffer`
3. `buf.toString('base64')` → `contentBase64`
4. Return result

**Output shape:**
```json
{
  "specId": "uuid",
  "section": "27 21 00",
  "title": "Structured Cabling",
  "sizeBytes": 84320,
  "contentBase64": "UEsDBBQA..."
}
```

**Tool description:** `"Generate a DOCX file from a stored spec. Returns base64-encoded content. Note: generates on-demand from current database state — not cached. Avoid calling in tight loops."`

**Future caching:** Phase 6 GitHub issue tracks pre-generation + storage + invalidation + locking. When implemented, this tool returns same shape but reads from cache when fresh. See ARCHITECTURE.md § Phase 6.

---

## Section 5: Tests

**File:** `src/mcp/server.integration.test.ts` — extend existing file

**Fixture reuse:** Existing `beforeAll` seeds `mcpSpecId` with a tree that includes node `'30000000-0000-0000-0000-000000000003'` (pr1: "Provide fiber optic backbone cabling."). Used as the known paragraph UUID for `get_paragraph` happy path.

**`parse_document` test fixture:** Use a UFGS `.sec` file from `docs/references/UFGS/` — read via `fs.readFileSync`, base64-encode inline in test. SEC files are UTF-8, fast to parse, no DOCX complexity.

| Suite | Test | Assertion |
|-------|------|-----------|
| `tool: get_paragraph` | valid UUID | `result.node.id === '30000000-...-000003'`, `ancestors.length >= 2` |
| `tool: get_paragraph` | unknown UUID | `result.isError === true` |
| `tool: parse_document` | valid base64 `.sec` | `specId` is UUID, `nodeCount > 0` |
| `tool: parse_document` | invalid base64 | `result.isError === true` |
| `tool: parse_document` | unsupported extension | `result.isError === true` |
| `tool: generate_docx` | valid specId | `contentBase64` is non-empty string, `sizeBytes > 0` |
| `tool: generate_docx` | unknown specId | `result.isError === true` |

**Cleanup:** `parse_document` test creates a new spec — `afterAll` must delete it. Capture returned `specId` in a test-scope variable and `DELETE FROM specs WHERE id = $1` in cleanup.

---

## Section 6: Doc Updates

### `README.md`

- Status table: `2b-iii | MCP tools: generate_docx, get_paragraph, parse_document | ✅ Complete (PR #XX)`
- MCP Server section: add entries for `get_paragraph`, `parse_document`, `generate_docx`
- "Not Yet Built": remove `generate_docx`, `get_paragraph`, `parse_document` lines
- Closing language: `Closes #29`

### `ARCHITECTURE.md`

- Phase 2b section: mark `2b-iii` as `✅ Complete`
- MCP tools list: add `get_paragraph`, `parse_document`, `generate_docx` with descriptions
- Module boundary table: update `mcp/` row
- Phase 6: add bullet — "DOCX cache layer (pre-generation, invalidation, locking) — see GitHub issue #XX"

### `CLAUDE.md`

- MCP Server Patterns section: update module boundary comment from `generator/markdown.ts only` to `generator/index.ts (markdown + generate), parser/index.ts (parse_document)`

---

## Test Plan

```bash
# Unit tests (no DB required)
pnpm test

# Integration tests (requires PostgreSQL via docker compose)
docker compose up -d postgres
pnpm migrate
pnpm seed
pnpm test:integration
```

Verify:
- `get_paragraph` returns node + 2 ancestors for known fixture paragraph
- `parse_document` with UFGS SEC fixture creates a new spec row
- `generate_docx` returns non-empty base64 for `mcpSpecId`
- All `isError` paths return `true` for invalid inputs

---

## Acceptance Criteria (from issue #29 + generate_docx addition)

- [ ] `get_paragraph` with valid UUID returns `{ node, ancestors }` with full ancestor chain
- [ ] `get_paragraph` with unknown UUID returns `isError: true`
- [ ] `parse_document` with valid base64-encoded UFGS `.sec` returns spec summary
- [ ] `parse_document` with invalid base64 returns `isError: true`
- [ ] `parse_document` with unsupported extension returns `isError: true`
- [ ] `generate_docx` with valid specId returns `{ specId, section, title, sizeBytes, contentBase64 }`
- [ ] `generate_docx` with unknown specId returns `isError: true`
- [ ] All integration tests pass (`pnpm test:integration`)
- [ ] `pnpm lint` clean
- [ ] `README.md` updated — `Closes #29`
