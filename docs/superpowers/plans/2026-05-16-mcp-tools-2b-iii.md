# Phase 2b-iii — MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three MCP tools — `get_paragraph`, `parse_document`, `generate_docx` — completing the Phase 2b MCP surface and closing issue #29.

**Architecture:** Three extracted handler functions added to `src/mcp/tools.ts` following the existing pattern. One new DB read function added to `src/db/queries/paragraphs.ts` using a recursive CTE to walk the parent chain. MCP module boundary expands to import from `parser/` and `generator/` (no `api/` internals).

**Tech Stack:** TypeScript, PostgreSQL recursive CTEs, `@modelcontextprotocol/sdk`, `dolanmiu/docx`, Vitest integration tests, `pnpm test:integration`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/queries/paragraphs.ts` | Modify | Add `getParagraphWithAncestors` + exported interfaces |
| `src/db/index.ts` | Modify | Re-export new function + types |
| `src/db/queries/paragraphs.integration.test.ts` | Create | Integration tests for `getParagraphWithAncestors` |
| `src/mcp/tools.ts` | Modify | Add 3 handlers + 3 `registerTool` calls + new imports |
| `src/mcp/server.integration.test.ts` | Modify | 7 new test cases across 3 tool suites; cleanup for `parse_document` spec |
| `README.md` | Modify | Status table, MCP section, remove from "Not Yet Built"; `Closes #29` |
| `ARCHITECTURE.md` | Modify | Phase 2b-iii status, MCP tools list, module boundary, Phase 6 cache note |
| `CLAUDE.md` | Modify | MCP module boundary line |

---

## Task 1: DB function `getParagraphWithAncestors`

**Files:**
- Modify: `src/db/queries/paragraphs.ts`
- Modify: `src/db/index.ts`
- Create: `src/db/queries/paragraphs.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `src/db/queries/paragraphs.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, getParagraphWithAncestors } from '../index.js';

const SPEC_ID  = 'b0000000-0000-0000-0000-000000000000';
const PART_ID  = 'b0000000-0000-0000-0000-000000000001';
const ART_ID   = 'b0000000-0000-0000-0000-000000000002';
const PR1_ID   = 'b0000000-0000-0000-0000-000000000003';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [SPEC_ID, '99 99 00', 'Ancestors Test', 'arcat']
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,NULL,'part','GENERAL',1) ON CONFLICT (id) DO NOTHING`,
    [PART_ID, SPEC_ID]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'article','SCOPE',1) ON CONFLICT (id) DO NOTHING`,
    [ART_ID, SPEC_ID, PART_ID]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'pr1','Test paragraph text.',1) ON CONFLICT (id) DO NOTHING`,
    [PR1_ID, SPEC_ID, ART_ID]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [SPEC_ID]);
});

describe('getParagraphWithAncestors', () => {
  it('returns node and full ancestor chain for a leaf paragraph', async () => {
    const result = await getParagraphWithAncestors(PR1_ID);
    expect(result).not.toBeNull();
    expect(result!.node.id).toBe(PR1_ID);
    expect(result!.node.nodeType).toBe('pr1');
    expect(result!.node.text).toBe('Test paragraph text.');
    expect(result!.ancestors).toHaveLength(2);
    expect(result!.ancestors[0]!.id).toBe(PART_ID);   // root first
    expect(result!.ancestors[0]!.nodeType).toBe('part');
    expect(result!.ancestors[1]!.id).toBe(ART_ID);
    expect(result!.ancestors[1]!.nodeType).toBe('article');
  });

  it('returns node with empty ancestors for a root-level paragraph', async () => {
    const result = await getParagraphWithAncestors(PART_ID);
    expect(result).not.toBeNull();
    expect(result!.node.id).toBe(PART_ID);
    expect(result!.ancestors).toHaveLength(0);
  });

  it('returns null for unknown UUID', async () => {
    const result = await getParagraphWithAncestors('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (function not exported yet)**

```bash
pnpm test:integration --reporter=verbose 2>&1 | grep -A5 'paragraphs.integration'
```

Expected: compile error or `getParagraphWithAncestors is not a function`.

- [ ] **Step 3: Add interfaces and function to `src/db/queries/paragraphs.ts`**

Replace the import line at the top:
```typescript
// Before:
import { DatabaseError } from '../index.js';

// After:
import { pool, DatabaseError } from '../index.js';
```

Add after the closing brace of `insertTree` (at end of file):

```typescript
export interface ParagraphRow {
  readonly id: string;
  readonly nodeType: string;
  readonly text: string;
  readonly vanish: boolean;
}

export interface ParagraphWithAncestors {
  readonly node: ParagraphRow;
  readonly ancestors: readonly ParagraphRow[];
}

interface ChainRow extends ParagraphRow {
  readonly depth: number;
}

export async function getParagraphWithAncestors(
  id: string
): Promise<ParagraphWithAncestors | null> {
  try {
    const result = await pool.query<ChainRow>(
      `WITH RECURSIVE chain AS (
         SELECT id, node_type, text, vanish, parent_id, 0 AS depth
         FROM paragraphs WHERE id = $1
         UNION ALL
         SELECT p.id, p.node_type, p.text, p.vanish, p.parent_id, c.depth + 1
         FROM paragraphs p JOIN chain c ON p.id = c.parent_id
       )
       SELECT id, node_type AS "nodeType", text, vanish, depth
       FROM chain ORDER BY depth DESC`,
      [id]
    );
    if (result.rows.length === 0) return null;
    const rows = result.rows;
    const node = rows[rows.length - 1]!;
    const ancestors = rows.slice(0, -1);
    return {
      node: { id: node.id, nodeType: node.nodeType, text: node.text, vanish: node.vanish },
      ancestors: ancestors.map((r) => ({
        id: r.id,
        nodeType: r.nodeType,
        text: r.text,
        vanish: r.vanish,
      })),
    };
  } catch (err) {
    throw new DatabaseError('getParagraphWithAncestors failed', { cause: err });
  }
}
```

- [ ] **Step 4: Re-export from `src/db/index.ts`**

Add at the end of the existing `export { insertTree } from './queries/paragraphs.js';` line — replace it with:

```typescript
export {
  insertTree,
  getParagraphWithAncestors,
} from './queries/paragraphs.js';
export type { ParagraphRow, ParagraphWithAncestors } from './queries/paragraphs.js';
```

- [ ] **Step 5: Run test — expect PASS**

```bash
pnpm test:integration --reporter=verbose 2>&1 | grep -A20 'paragraphs.integration'
```

Expected: 3 tests pass.

- [ ] **Step 6: Run lint**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/paragraphs.ts src/db/index.ts src/db/queries/paragraphs.integration.test.ts
git commit -m "feat(db): getParagraphWithAncestors — recursive CTE ancestor chain query"
```

---

## Task 2: `get_paragraph` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.integration.test.ts`

- [ ] **Step 1: Add failing integration test**

In `src/mcp/server.integration.test.ts`, add after the `describe('resource: specr://sections', ...)` block (before the `describe('GET /mcp', ...)` block):

```typescript
describe('tool: get_paragraph', () => {
  it('returns node and ancestor chain for known paragraph', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_paragraph',
      arguments: { paragraphId: '30000000-0000-0000-0000-000000000003' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      node: { id: string; nodeType: string };
      ancestors: { id: string; nodeType: string }[];
    };
    expect(data.node.id).toBe('30000000-0000-0000-0000-000000000003');
    expect(data.node.nodeType).toBe('pr1');
    expect(data.ancestors).toHaveLength(2);
    expect(data.ancestors[0]!.nodeType).toBe('part');
    expect(data.ancestors[1]!.nodeType).toBe('article');
  });

  it('returns isError for unknown UUID', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_paragraph',
      arguments: { paragraphId: '00000000-0000-0000-0000-000000000000' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (tool not registered)**

```bash
pnpm test:integration --reporter=verbose 2>&1 | grep -A10 'get_paragraph'
```

Expected: FAIL — tool not found or method error.

- [ ] **Step 3: Add `get_paragraph` handler and registration to `src/mcp/tools.ts`**

Add to the imports at the top:

```typescript
import { getParagraphWithAncestors } from '../db/index.js';
```

Merge with the existing db import line:
```typescript
// Before:
import { searchParagraphs, listCsiSections, getSpecTree } from '../db/index.js';

// After:
import {
  searchParagraphs,
  listCsiSections,
  getSpecTree,
  getParagraphWithAncestors,
} from '../db/index.js';
```

Add the handler function before `registerTools`:

```typescript
async function handleGetParagraph({ paragraphId }: { paragraphId: string }) {
  try {
    const result = await getParagraphWithAncestors(paragraphId);
    if (!result) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Paragraph not found: id=${paragraphId}` }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    logger.error({ err }, 'mcp tool get_paragraph failed');
    return {
      isError: true,
      content: [{ type: 'text' as const, text: 'Internal error — paragraph retrieval failed' }],
    };
  }
}
```

Add `registerTool` call inside `registerTools`, after the existing `list_sections` registration:

```typescript
  server.registerTool(
    'get_paragraph',
    {
      description:
        'Return a single paragraph with its full ancestor chain (root to immediate parent). Use to get context around a search_library result.',
      inputSchema: {
        paragraphId: z.uuid().describe('Paragraph UUID (from search_library or get_spec)'),
      },
    },
    handleGetParagraph
  );
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm test:integration --reporter=verbose 2>&1 | grep -A10 'get_paragraph'
```

Expected: 2 tests pass.

- [ ] **Step 5: Run lint**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.integration.test.ts
git commit -m "feat(mcp): get_paragraph tool — node + ancestor chain via recursive CTE"
```

---

## Task 3: `parse_document` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.integration.test.ts`

- [ ] **Step 1: Add failing integration test and cleanup**

At the top of `src/mcp/server.integration.test.ts`, add after `let mcpSpecId: string`:

```typescript
let parsedSpecId: string | null = null;
```

Update the existing `afterAll` to also clean up the spec created by `parse_document`:

```typescript
afterAll(async () => {
  if (parsedSpecId) {
    await pool.query('DELETE FROM specs WHERE id = $1', [parsedSpecId]);
  }
  await pool.query('DELETE FROM specs WHERE id = $1', [mcpSpecId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});
```

Add the import for `readFileSync` and `join` at the top:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
```

Add test suite after the `get_paragraph` suite (before `GET /mcp`):

```typescript
describe('tool: parse_document', () => {
  it('parses a valid base64-encoded SEC file and returns spec summary', async () => {
    const secBuffer = readFileSync(join(process.cwd(), 'tests/fixtures/sec/27_10_00.SEC'));
    const secBase64 = secBuffer.toString('base64');

    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'parse_document',
      arguments: { filename: '27_10_00.SEC', contentBase64: secBase64 },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      specId: string;
      section: string;
      title: string;
      nodeCount: number;
    };
    expect(typeof data.specId).toBe('string');
    expect(data.nodeCount).toBeGreaterThan(0);
    parsedSpecId = data.specId;
  });

  it('returns isError for invalid base64', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'parse_document',
      arguments: { filename: 'test.sec', contentBase64: '!!!not-base64!!!' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });

  it('returns isError for unsupported file extension', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'parse_document',
      arguments: { filename: 'file.pdf', contentBase64: Buffer.from('hello').toString('base64') },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm test:integration --reporter=verbose 2>&1 | grep -A10 'parse_document'
```

Expected: FAIL — tool not registered.

- [ ] **Step 3: Add new imports to `src/mcp/tools.ts`**

Add at top of file:

```typescript
import path from 'node:path';
import type { CsiNode, CsiTree } from '../ast/types.js';
import { parseSec, parseDocx, assertDocxSafe, assertSecSafe } from '../parser/index.js';
```

Add `pool`, `createSpec`, `insertTree` to existing db import:

```typescript
import {
  searchParagraphs,
  listCsiSections,
  getSpecTree,
  getParagraphWithAncestors,
  pool,
  createSpec,
  insertTree,
} from '../db/index.js';
```

- [ ] **Step 4: Add `countNodes`, `persistParsedSpec`, and `handleParseDocument` to `src/mcp/tools.ts`**

Add before `registerTools`:

```typescript
function countNodes(nodes: readonly CsiNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

async function persistParsedSpec(tree: CsiTree): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = tree.parts[0]?.meta.source ?? 'unknown';
    const specId = await createSpec({ section: tree.section, title: tree.title, source }, client);
    const treeWithId: CsiTree = { ...tree, id: specId };
    await insertTree(treeWithId, specId, client);
    await client.query('COMMIT');
    return specId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function handleParseDocument({
  filename,
  contentBase64,
}: {
  filename: string;
  contentBase64: string;
}) {
  try {
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.docx' && ext !== '.sec') {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unsupported extension: ${ext}. Use .docx or .sec` }],
      };
    }

    const estimatedBytes = Math.ceil((contentBase64.length * 3) / 4);
    if (estimatedBytes > 10 * 1024 * 1024) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'Content exceeds 10 MB decoded limit' }],
      };
    }

    const buf = Buffer.from(contentBase64, 'base64');

    try {
      if (ext === '.docx') await assertDocxSafe(buf);
      else assertSecSafe(buf);
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: err instanceof Error ? err.message : 'invalid file' },
        ],
      };
    }

    const noop = (_stage: string, _pct: number): void => {};
    const tree =
      ext === '.sec' ? parseSec(buf.toString('utf-8')).tree : await parseDocx(buf, noop);

    const specId = await persistParsedSpec(tree);
    const nodeCount = countNodes(tree.parts);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { specId, section: tree.section, title: tree.title, nodeCount },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    logger.error({ err }, 'mcp tool parse_document failed');
    return {
      isError: true,
      content: [{ type: 'text' as const, text: 'Internal error — parse failed' }],
    };
  }
}
```

- [ ] **Step 5: Add `parse_document` registration to `registerTools`**

Add after the `get_paragraph` `registerTool` call:

```typescript
  server.registerTool(
    'parse_document',
    {
      description:
        'Parse a DOCX or SEC specification file and store it in the database. Pass the file content as base64. Returns the new spec ID and summary. Note: computation-intensive for large DOCX files.',
      inputSchema: {
        filename: z
          .string()
          .describe('Original filename — extension determines format (.docx or .sec)'),
        contentBase64: z
          .string()
          .describe('Base64-encoded file content (max 10 MB decoded)'),
      },
    },
    handleParseDocument
  );
```

- [ ] **Step 6: Run test — expect PASS**

```bash
pnpm test:integration --reporter=verbose 2>&1 | grep -A15 'parse_document'
```

Expected: 3 tests pass.

- [ ] **Step 7: Run lint**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.integration.test.ts
git commit -m "feat(mcp): parse_document tool — base64 DOCX/SEC ingest with safety validation"
```

---

## Task 4: `generate_docx` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.integration.test.ts`

- [ ] **Step 1: Add failing integration test**

Add the import for `generateDocx` check — the test uses `mcpSpecId` already seeded in `beforeAll`. Add after the `parse_document` suite (before `GET /mcp`):

```typescript
describe('tool: generate_docx', () => {
  it('returns base64 DOCX for a valid spec', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'generate_docx',
      arguments: { specId: mcpSpecId },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      specId: string;
      section: string;
      title: string;
      sizeBytes: number;
      contentBase64: string;
    };
    expect(data.specId).toBe(mcpSpecId);
    expect(data.sizeBytes).toBeGreaterThan(0);
    expect(typeof data.contentBase64).toBe('string');
    expect(data.contentBase64.length).toBeGreaterThan(0);
  });

  it('returns isError for unknown spec UUID', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'generate_docx',
      arguments: { specId: '00000000-0000-0000-0000-000000000000' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm test:integration --reporter=verbose 2>&1 | grep -A10 'generate_docx'
```

Expected: FAIL — tool not registered.

- [ ] **Step 3: Add `generateDocx` import to `src/mcp/tools.ts`**

Add after the parser import:

```typescript
import { generateDocx } from '../generator/index.js';
```

- [ ] **Step 4: Add `handleGenerateDocx` handler to `src/mcp/tools.ts`**

Add before `registerTools`:

```typescript
async function handleGenerateDocx({ specId }: { specId: string }) {
  try {
    const result = await getSpecTree(specId);
    if (!result) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Spec not found: id=${specId}` }],
      };
    }
    const buf = await generateDocx(result.tree);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              specId,
              section: result.tree.section,
              title: result.tree.title,
              sizeBytes: buf.byteLength,
              contentBase64: buf.toString('base64'),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    logger.error({ err }, 'mcp tool generate_docx failed');
    return {
      isError: true,
      content: [{ type: 'text' as const, text: 'Internal error — DOCX generation failed' }],
    };
  }
}
```

- [ ] **Step 5: Add `generate_docx` registration to `registerTools`**

Add after the `parse_document` `registerTool` call:

```typescript
  server.registerTool(
    'generate_docx',
    {
      description:
        'Generate a DOCX file from a stored spec. Returns base64-encoded content (typically 50–400 KB). Note: generates on-demand from current database state — not cached. Avoid calling in tight loops.',
      inputSchema: {
        specId: z.uuid().describe('Spec UUID to generate DOCX for'),
      },
    },
    handleGenerateDocx
  );
```

- [ ] **Step 6: Run all integration tests**

```bash
pnpm test:integration --reporter=verbose
```

Expected: all existing tests still pass + 2 new `generate_docx` tests pass.

- [ ] **Step 7: Run full test suite**

```bash
pnpm test && pnpm test:integration
```

Expected: all tests pass.

- [ ] **Step 8: Run lint**

```bash
pnpm lint
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.integration.test.ts
git commit -m "feat(mcp): generate_docx tool — on-demand DOCX generation returning base64"
```

---

## Task 5: Doc updates + GitHub issue

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `README.md` status table**

Find the `2b-iii` row in the status table:

```markdown
| 2b-iii | MCP tools: `generate_docx`, `get_paragraph` (issue #29) | Planned |
```

Replace with:

```markdown
| 2b-iii | MCP tools: `get_paragraph`, `parse_document`, `generate_docx` | ✅ Complete (PR #XX) |
```

- [ ] **Step 2: Update `README.md` MCP Server section**

Find the existing tool list. After the `list_sections` entry, add:

```markdown
- **Tool: `get_paragraph(paragraphId)`** — returns `{ node, ancestors }` for a single paragraph. `node` is `{ id, nodeType, text, vanish }`. `ancestors` is ordered root → immediate parent.
- **Tool: `parse_document(filename, contentBase64)`** — base64-decode a DOCX or SEC file, parse it, insert into the database, and return `{ specId, section, title, nodeCount }`. Max 10 MB decoded. Computation-intensive for large DOCX files.
- **Tool: `generate_docx(specId)`** — generate a DOCX from a stored spec, returned as base64 in `{ specId, section, title, sizeBytes, contentBase64 }`. On-demand from current DB state — not cached.
```

- [ ] **Step 3: Update `README.md` "Not Yet Built" section**

Remove these lines:

```markdown
- MCP write tools for generator: `generate_docx`, `get_paragraph` (Phase 2b-iii, issue #29)
```

And:

```markdown
- MCP stateful sessions, `get_paragraph` + `parse_document` tools — Phase 2b follow-up
```

- [ ] **Step 4: Add `Closes #29` to `README.md`**

At the bottom of the "Not Yet Built" section or a visible location, this will be in the PR body — but update the status table row to include `Closes #29` in the PR description (not the README itself). Skip this step — it belongs in the PR description.

- [ ] **Step 5: Update `ARCHITECTURE.md` Phase 2b section**

Find:

```markdown
- **2b-iii** — MCP tools: `generate_docx`, `get_paragraph` (issue #29)
```

Replace with:

```markdown
- **2b-iii** ✅ — `get_paragraph(paragraphId)` → `{ node, ancestors[] }` ancestor chain via recursive CTE; `parse_document(filename, contentBase64)` → ingest DOCX/SEC via MCP with base64 encoding; `generate_docx(specId)` → on-demand base64 DOCX. (PR #XX, issue #29)
```

- [ ] **Step 6: Update `ARCHITECTURE.md` module boundary note for MCP**

Find in ARCHITECTURE.md:

```
mcp/       ← imports from db/index.ts and generator/markdown.ts only; no parser/ or api/ internals
```

Replace with:

```
mcp/       ← imports from db/index.ts, generator/index.ts, parser/index.ts; no api/ internals
```

- [ ] **Step 7: Update `ARCHITECTURE.md` Phase 6 section**

Find the Phase 6 bullet list. Add:

```markdown
- DOCX cache layer — pre-generate + store DOCX on spec write, invalidate on paragraph change, locking to prevent stale reads (see GitHub issue #XX)
```

- [ ] **Step 8: Update `CLAUDE.md` MCP module boundary line**

Find in CLAUDE.md (in "MCP Server Patterns" or "Module Boundaries" section):

```
mcp/       ← imports from db/index.ts and generator/markdown.ts only; no parser/ or api/ internals
```

Replace with:

```
mcp/       ← imports from db/index.ts, generator/index.ts, parser/index.ts; no api/ internals
```

- [ ] **Step 9: Open GitHub issue for DOCX cache layer**

```bash
gh issue create \
  --title "feat(generator): DOCX cache layer — pre-generation, storage, invalidation + locking" \
  --label "phase:6" \
  --body "$(cat <<'EOF'
## Context

The \`generate_docx\` MCP tool (Phase 2b-iii, PR #XX) generates DOCX on-demand from current DB state on every call. This is correct and drift-free but computation-intensive for large specs.

## Proposed design

- Pre-generate DOCX when a spec is written/updated and store in blob storage (or filesystem)
- Locking: any in-flight DB change to a spec's paragraphs blocks \`generate_docx\` reads until new DOCX is generated and stored
- Cache invalidation: triggered on any `UPDATE paragraphs WHERE spec_id = ...` or `INSERT/DELETE paragraphs WHERE spec_id = ...`
- \`generate_docx\` reads from cache when fresh; falls back to on-demand if cache miss

## Prerequisite

Phase 3 (merge engine) must be complete before cache invalidation design is finalized — merge operations touch many paragraphs in a single transaction.

## Out of scope until Phase 5+

Do not implement before Phase 3 is complete and performance profiling shows this is actually a bottleneck.
EOF
)"
```

Note the issue number returned — use it to fill `#XX` placeholders in Steps 5 and 7 above.

- [ ] **Step 10: Run full test suite one final time**

```bash
pnpm test && pnpm test:integration && pnpm lint
```

Expected: all pass.

- [ ] **Step 11: Commit doc updates**

```bash
git add README.md ARCHITECTURE.md CLAUDE.md
git commit -m "docs: Phase 2b-iii complete — MCP tools, module boundary update, cache issue"
```

---

## Final: Create PR

- [ ] **Create PR targeting `main`**

```bash
gh pr create \
  --title "feat(mcp): Phase 2b-iii — get_paragraph, parse_document, generate_docx MCP tools" \
  --base main \
  --body "$(cat <<'EOF'
## Summary

- Adds `get_paragraph` MCP tool — returns single paragraph with full ancestor chain (root → immediate parent) via PostgreSQL recursive CTE
- Adds `parse_document` MCP tool — accepts base64-encoded DOCX or SEC file, validates safety, parses, persists, returns `{ specId, section, title, nodeCount }`
- Adds `generate_docx` MCP tool — generates DOCX from stored spec on-demand, returns base64 in `{ specId, section, title, sizeBytes, contentBase64 }`
- Expands MCP module boundary to import from `parser/` and `generator/` (no `api/` internals)
- Opens GitHub issue for future DOCX cache layer (Phase 6)

Closes #29

## Test plan

- [ ] `pnpm test` — all unit tests pass
- [ ] `pnpm test:integration` — all 7 new integration tests pass (2 `get_paragraph`, 3 `parse_document`, 2 `generate_docx`) plus all existing MCP tests
- [ ] `pnpm lint` — clean
- [ ] `get_paragraph('30000000-...-000003')` returns pr1 node + 2 ancestors (part, article)
- [ ] `parse_document` with `27_10_00.SEC` fixture creates new spec row, `nodeCount > 0`
- [ ] `generate_docx` with test spec returns non-empty base64 DOCX
EOF
)"
```

---

## Self-Review Notes

- `parsedSpecId` variable declared at module scope in integration test so `afterAll` can reference it — set during the `parse_document` happy-path test. ✓
- `countNodes` is a local duplicate of the function in `parse.ts` — intentional (no cross-module import from api/). ✓
- `persistParsedSpec` mirrors `parse.ts:persistTree` exactly — if either changes, the other needs updating. Extraction to db layer deferred until Phase 3 needs it too. ✓
- `assertSecSafe` is synchronous (no `await` needed) — matches `parse.ts` usage pattern. ✓
- Recursive CTE depth ordering: `depth=0` = queried paragraph (last row after `ORDER BY depth DESC`), `depth=1+` = ancestors (earlier rows). Slicing `rows.slice(0, -1)` gives ancestors root-first. ✓
- `buf.byteLength` in `generate_docx` reports pre-base64 size (the actual DOCX binary size). ✓
- `ON CONFLICT (id) DO NOTHING` in `paragraphs.integration.test.ts` `beforeAll` is safe for re-runs. ✓
