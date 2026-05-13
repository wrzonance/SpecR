# MCP Server Phase 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only MCP server to SpecR — stateless Streamable HTTP on the existing Express app — exposing 3 tools and 2 resources backed by the live PostgreSQL database.

**Architecture:** `McpServer` (SDK high-level class) is created fresh per request and mounted at `POST /mcp` on the existing Express router. Tools and resources are registered via pure functions (`registerTools`, `registerResources`) that are called each time a server is created. The Markdown renderer (`src/generator/markdown.ts`) is a pure function shared with the future DOCX generator.

**Tech Stack:** `@modelcontextprotocol/sdk` v1.29.0 (already installed), `StreamableHTTPServerTransport` stateless mode, Zod v4 raw shapes for tool input schemas, PostgreSQL via existing `pool`.

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `src/generator/markdown.ts` | **Create** | `getLabel()` + `renderMarkdown()` — pure, no I/O |
| `src/generator/markdown.test.ts` | **Create** | Unit tests for renderer |
| `src/db/queries/specs.ts` | **Modify** | Add `getSpecTree()` — recursive paragraph fetch + cross-refs |
| `src/db/queries/specs.integration.test.ts` | **Modify** | Add `getSpecTree` integration tests |
| `src/db/queries/search.ts` | **Create** | `searchParagraphs()` + `listCsiSections()` |
| `src/db/queries/search.integration.test.ts` | **Create** | Integration tests for search queries |
| `src/db/index.ts` | **Modify** | Re-export new query functions |
| `src/mcp/server.ts` | **Create** | `registerMcpRoutes(app)` — transport + McpServer wiring |
| `src/mcp/tools.ts` | **Create** | `registerTools(server)` — 3 tool handlers |
| `src/mcp/resources.ts` | **Create** | `registerResources(server)` — 2 resource handlers |
| `src/mcp/server.integration.test.ts` | **Create** | End-to-end MCP JSON-RPC tests |
| `src/index.ts` | **Modify** | Call `registerMcpRoutes(app)` |

---

## Task 1: Markdown Renderer

**Files:**
- Create: `src/generator/markdown.ts`
- Create: `src/generator/markdown.test.ts`

- [ ] **Step 1.1: Write failing tests**

```typescript
// src/generator/markdown.test.ts
import { describe, it, expect } from 'vitest';
import { getLabel, renderMarkdown } from './markdown.js';
import type { CsiTree } from '../ast/types.js';

describe('getLabel', () => {
  it('labels parts', () => {
    expect(getLabel('part', 0)).toBe('PART 1 -');
    expect(getLabel('part', 2)).toBe('PART 3 -');
  });
  it('labels articles with part number', () => {
    expect(getLabel('article', 0, 1)).toBe('1.1');
    expect(getLabel('article', 2, 2)).toBe('2.3');
  });
  it('labels pr1 A. B. C.', () => {
    expect(getLabel('pr1', 0)).toBe('A.');
    expect(getLabel('pr1', 25)).toBe('Z.');
  });
  it('labels pr2 1. 2. 3.', () => {
    expect(getLabel('pr2', 0)).toBe('1.');
    expect(getLabel('pr2', 2)).toBe('3.');
  });
  it('labels pr3 a. b. c.', () => {
    expect(getLabel('pr3', 0)).toBe('a.');
    expect(getLabel('pr3', 2)).toBe('c.');
  });
  it('labels pr4 1) 2) 3)', () => {
    expect(getLabel('pr4', 0)).toBe('1)');
    expect(getLabel('pr4', 3)).toBe('4)');
  });
  it('labels pr5 a) b)', () => {
    expect(getLabel('pr5', 0)).toBe('a)');
    expect(getLabel('pr5', 1)).toBe('b)');
  });
  it('returns empty for non-numbered types', () => {
    expect(getLabel('spec', 0)).toBe('');
    expect(getLabel('note', 0)).toBe('');
    expect(getLabel('continuation', 0)).toBe('');
  });
});

const TREE: CsiTree = {
  id: '00000000-0000-0000-0000-000000000001',
  section: '27 21 00',
  title: 'Structured Cabling',
  parts: [
    {
      id: '00000000-0000-0000-0000-000000000002',
      type: 'part',
      text: 'GENERAL',
      children: [
        {
          id: '00000000-0000-0000-0000-000000000003',
          type: 'article',
          text: 'REFERENCES',
          children: [
            {
              id: '00000000-0000-0000-0000-000000000004',
              type: 'pr1',
              text: 'Coordinate work of all trades.',
              children: [
                {
                  id: '00000000-0000-0000-0000-000000000006',
                  type: 'pr2',
                  text: 'Include cable routing plans.',
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
            {
              id: '00000000-0000-0000-0000-000000000005',
              type: 'note',
              text: 'Edit for local conditions.',
              children: [],
              meta: { vanish: true },
            },
          ],
          meta: {},
        },
      ],
      meta: {},
    },
  ],
};

describe('renderMarkdown', () => {
  it('renders section heading', () => {
    expect(renderMarkdown(TREE)).toContain('# SECTION 27 21 00 — Structured Cabling');
  });
  it('renders part heading', () => {
    expect(renderMarkdown(TREE)).toContain('## PART 1 - GENERAL');
  });
  it('renders article heading', () => {
    expect(renderMarkdown(TREE)).toContain('### 1.1 REFERENCES');
  });
  it('renders pr1 label', () => {
    expect(renderMarkdown(TREE)).toContain('A. Coordinate work of all trades.');
  });
  it('renders pr2 label indented', () => {
    expect(renderMarkdown(TREE)).toContain('   1. Include cable routing plans.');
  });
  it('renders note as blockquote', () => {
    expect(renderMarkdown(TREE)).toContain('> **[NOTE]** Edit for local conditions.');
  });
  it('renders empty tree without error', () => {
    const empty: CsiTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '00 00 00',
      title: 'Empty',
      parts: [],
    };
    expect(renderMarkdown(empty)).toBe('# SECTION 00 00 00 — Empty');
  });
  it('renders continuation without label', () => {
    const withCont: CsiTree = {
      id: '00000000-0000-0000-0000-000000000001',
      section: '27 21 00',
      title: 'Test',
      parts: [
        {
          id: '00000000-0000-0000-0000-000000000002',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '00000000-0000-0000-0000-000000000003',
              type: 'article',
              text: 'SCOPE',
              children: [
                {
                  id: '00000000-0000-0000-0000-000000000007',
                  type: 'continuation',
                  text: 'See applicable standards.',
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    };
    const md = renderMarkdown(withCont);
    expect(md).toContain('See applicable standards.');
    expect(md).not.toContain('A. See applicable standards.');
  });
});
```

- [ ] **Step 1.2: Run tests — expect FAIL** (module not found)

```bash
pnpm test -- --reporter=verbose 2>&1 | grep -E "FAIL|PASS|markdown"
```

- [ ] **Step 1.3: Implement markdown renderer**

```typescript
// src/generator/markdown.ts
import type { CsiNode, CsiTree, NodeType } from '../ast/types.js';

export function getLabel(type: NodeType, index: number, partNumber = 1): string {
  switch (type) {
    case 'part':    return `PART ${index + 1} -`;
    case 'article': return `${partNumber}.${index + 1}`;
    case 'pr1':     return `${String.fromCharCode(65 + index)}.`;
    case 'pr2':     return `${index + 1}.`;
    case 'pr3':     return `${String.fromCharCode(97 + index)}.`;
    case 'pr4':     return `${index + 1})`;
    case 'pr5':     return `${String.fromCharCode(97 + index)})`;
    default:        return '';
  }
}

const INDENT = '   ';

function renderPrNode(node: CsiNode, index: number, depth: number): string {
  if (node.type === 'note' || node.meta.vanish) {
    return `\n> **[NOTE]** ${node.text}`;
  }
  if (node.type === 'continuation') {
    return `\n${INDENT.repeat(depth)}${node.text}`;
  }
  const pad = INDENT.repeat(depth);
  const label = getLabel(node.type, index);
  const lines = [`\n${pad}${label} ${node.text}`];
  node.children.forEach((child, i) => lines.push(renderPrNode(child, i, depth + 1)));
  return lines.join('');
}

function renderArticle(node: CsiNode, index: number, partNumber: number): string {
  const label = getLabel('article', index, partNumber);
  const lines = [`\n### ${label} ${node.text}\n`];
  node.children.forEach((child, i) => lines.push(renderPrNode(child, i, 0)));
  return lines.join('');
}

function renderPart(node: CsiNode, index: number): string {
  const label = getLabel('part', index);
  const lines = [`\n## ${label} ${node.text}\n`];
  node.children.forEach((child, i) => lines.push(renderArticle(child, i, index + 1)));
  return lines.join('');
}

export function renderMarkdown(tree: CsiTree): string {
  const lines = [`# SECTION ${tree.section} — ${tree.title}`];
  tree.parts.forEach((part, i) => lines.push(renderPart(part, i)));
  return lines.join('\n');
}
```

- [ ] **Step 1.4: Run tests — expect PASS**

```bash
pnpm test -- --reporter=verbose 2>&1 | grep -E "FAIL|PASS|markdown"
```

Expected: all `markdown.test.ts` tests pass.

- [ ] **Step 1.5: Lint**

```bash
pnpm lint 2>&1 | grep -E "error|warning" | head -20
```

- [ ] **Step 1.6: Commit**

```bash
git add src/generator/markdown.ts src/generator/markdown.test.ts
git commit -m "feat(generator): markdown renderer — getLabel + renderMarkdown"
```

---

## Task 2: DB — `getSpecTree`

Adds recursive paragraph fetch + cross-reference query to `src/db/queries/specs.ts`.

**Files:**
- Modify: `src/db/queries/specs.ts`
- Modify: `src/db/queries/specs.integration.test.ts`

- [ ] **Step 2.1: Write failing integration test**

Append to `src/db/queries/specs.integration.test.ts`:

```typescript
import { insertTree } from './paragraphs.js';
import { getSpecTree } from './specs.js';

describe('getSpecTree', () => {
  let treeSpecId: string;

  beforeEach(async () => {
    treeSpecId = await createSpec({ section: '99 00 00', title: 'Tree Test', source: 'arcat' });
    await insertTree(
      {
        id: treeSpecId,
        section: '99 00 00',
        title: 'Tree Test',
        parts: [
          {
            id: '10000000-0000-0000-0000-000000000001',
            type: 'part',
            text: 'GENERAL',
            children: [
              {
                id: '10000000-0000-0000-0000-000000000002',
                type: 'article',
                text: 'REFERENCES',
                children: [
                  {
                    id: '10000000-0000-0000-0000-000000000003',
                    type: 'pr1',
                    text: 'Coordinate work.',
                    children: [],
                    meta: {},
                  },
                ],
                meta: {},
              },
            ],
            meta: {},
          },
        ],
      },
      treeSpecId,
      pool
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [treeSpecId]);
  });

  it('returns null for unknown id', async () => {
    const result = await getSpecTree('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('reconstructs part → article → pr1 hierarchy', async () => {
    const result = await getSpecTree(treeSpecId);
    expect(result).not.toBeNull();
    expect(result!.tree.parts).toHaveLength(1);
    expect(result!.tree.parts[0]!.type).toBe('part');
    expect(result!.tree.parts[0]!.children).toHaveLength(1);
    expect(result!.tree.parts[0]!.children[0]!.type).toBe('article');
    expect(result!.tree.parts[0]!.children[0]!.children).toHaveLength(1);
    expect(result!.tree.parts[0]!.children[0]!.children[0]!.type).toBe('pr1');
  });

  it('returns empty references array when no refs exist', async () => {
    const result = await getSpecTree(treeSpecId);
    expect(result!.references).toEqual([]);
  });
});
```

- [ ] **Step 2.2: Run integration test — expect FAIL**

```bash
pnpm test:integration 2>&1 | grep -E "FAIL|PASS|getSpecTree"
```

- [ ] **Step 2.3: Implement `getSpecTree`**

Add to `src/db/queries/specs.ts` (after existing imports and interfaces):

```typescript
import type { NodeType } from '../../ast/types.js';

interface ParaRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly node_type: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
}

export interface SpecReference {
  readonly referenceText: string;
  readonly targetSection: string | null;
  readonly targetSpecId: string | null;
  readonly isResolved: boolean;
  readonly isBroken: boolean;
}

export interface SpecTreeResult {
  readonly tree: CsiTree;
  readonly references: readonly SpecReference[];
}

function buildNodeTree(rows: readonly ParaRow[]): readonly CsiNode[] {
  const childrenByParent = new Map<string | null, ParaRow[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.parent_id) ?? [];
    siblings.push(row);
    childrenByParent.set(row.parent_id, siblings);
  }

  function buildNode(row: ParaRow): CsiNode {
    const children = (childrenByParent.get(row.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map(buildNode);
    return {
      id: row.id,
      type: row.node_type as NodeType,
      text: row.text,
      children,
      meta: row.vanish ? { vanish: true } : {},
    };
  }

  return (childrenByParent.get(null) ?? [])
    .sort((a, b) => a.position - b.position)
    .map(buildNode);
}

export async function getSpecTree(id: string): Promise<SpecTreeResult | null> {
  try {
    const specResult = await pool.query<SpecRow>(
      'SELECT id, section, title FROM specs WHERE id = $1',
      [id]
    );
    const specRow = specResult.rows[0];
    if (!specRow) return null;

    const paraResult = await pool.query<ParaRow>(
      `SELECT id, parent_id, node_type, text, position, vanish
       FROM paragraphs WHERE spec_id = $1`,
      [id]
    );

    const refResult = await pool.query<{
      reference_text: string;
      target_spec_section: string | null;
      target_spec_id: string | null;
      is_broken: boolean;
    }>(
      `SELECT reference_text, target_spec_section, target_spec_id, is_broken
       FROM spec_references WHERE source_spec_id = $1`,
      [id]
    );

    const tree: CsiTree = {
      id: specRow.id,
      section: specRow.section ?? '',
      title: specRow.title ?? '',
      parts: buildNodeTree(paraResult.rows),
    };

    const references: readonly SpecReference[] = refResult.rows.map((row) => ({
      referenceText: row.reference_text,
      targetSection: row.target_spec_section,
      targetSpecId: row.target_spec_id,
      isResolved: row.target_spec_id !== null,
      isBroken: row.is_broken,
    }));

    return { tree, references };
  } catch (err) {
    throw new DatabaseError('getSpecTree failed', { cause: err });
  }
}
```

- [ ] **Step 2.4: Run integration test — expect PASS**

```bash
pnpm test:integration 2>&1 | grep -E "FAIL|PASS|getSpecTree"
```

- [ ] **Step 2.5: Add re-export to `src/db/index.ts`**

Append to the export block at the bottom of `src/db/index.ts`:

```typescript
export { getSpecTree } from './queries/specs.js';
export type { SpecTreeResult, SpecReference } from './queries/specs.js';
```

- [ ] **Step 2.6: Lint + commit**

```bash
pnpm lint 2>&1 | grep -E "error" | head -20
git add src/db/queries/specs.ts src/db/queries/specs.integration.test.ts src/db/index.ts
git commit -m "feat(db): getSpecTree — paragraph tree reconstruction + cross-refs"
```

---

## Task 3: DB — `searchParagraphs` + `listCsiSections`

**Files:**
- Create: `src/db/queries/search.ts`
- Create: `src/db/queries/search.integration.test.ts`
- Modify: `src/db/index.ts`

- [ ] **Step 3.1: Write failing integration tests**

```typescript
// src/db/queries/search.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { createSpec } from './specs.js';
import { insertTree } from './paragraphs.js';
import { searchParagraphs, listCsiSections } from './search.js';

let searchSpecId: string;

beforeAll(async () => {
  searchSpecId = await createSpec({
    section: '27 21 00',
    title: 'Search Test Spec',
    source: 'arcat',
  });
  await insertTree(
    {
      id: searchSpecId,
      section: '27 21 00',
      title: 'Search Test Spec',
      parts: [
        {
          id: '20000000-0000-0000-0000-000000000001',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '20000000-0000-0000-0000-000000000002',
              type: 'article',
              text: 'REFERENCES',
              children: [
                {
                  id: '20000000-0000-0000-0000-000000000003',
                  type: 'pr1',
                  text: 'Fiber optic backbone cabling requirements.',
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    },
    searchSpecId,
    pool
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [searchSpecId]);
});

describe('searchParagraphs', () => {
  it('returns matching paragraphs', async () => {
    const results = await searchParagraphs('fiber optic');
    const match = results.find((r) => r.specId === searchSpecId);
    expect(match).toBeDefined();
    expect(match!.text).toBe('Fiber optic backbone cabling requirements.');
    expect(match!.nodeType).toBe('pr1');
    expect(match!.specSection).toBe('27 21 00');
  });

  it('returns empty array for no match', async () => {
    const results = await searchParagraphs('xyznonexistentquery12345');
    expect(results).toEqual([]);
  });

  it('filters by division', async () => {
    const results = await searchParagraphs('fiber optic', '27');
    expect(results.some((r) => r.specId === searchSpecId)).toBe(true);

    const noResults = await searchParagraphs('fiber optic', '01');
    expect(noResults.some((r) => r.specId === searchSpecId)).toBe(false);
  });

  it('respects limit', async () => {
    const results = await searchParagraphs('', undefined, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe('listCsiSections', () => {
  it('returns sections with inDatabase flag', async () => {
    const sections = await listCsiSections('27');
    const s = sections.find((r) => r.section === '27 21 00');
    expect(s).toBeDefined();
    expect(s!.inDatabase).toBe(true);
  });

  it('returns sections not in DB with inDatabase=false', async () => {
    const sections = await listCsiSections('27');
    const notLoaded = sections.filter((r) => !r.inDatabase);
    expect(notLoaded.length).toBeGreaterThan(0);
  });

  it('returns all divisions when no filter given', async () => {
    const sections = await listCsiSections();
    expect(sections.length).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 3.2: Run integration tests — expect FAIL**

```bash
pnpm test:integration 2>&1 | grep -E "FAIL|PASS|search"
```

- [ ] **Step 3.3: Implement `src/db/queries/search.ts`**

```typescript
// src/db/queries/search.ts
import { pool, DatabaseError } from '../index.js';

export interface ParagraphSearchResult {
  readonly paragraphId: string;
  readonly text: string;
  readonly nodeType: string;
  readonly specId: string;
  readonly specSection: string;
  readonly specTitle: string;
}

export interface CsiSectionResult {
  readonly section: string;
  readonly title: string;
  readonly division: string;
  readonly inDatabase: boolean;
}

export async function searchParagraphs(
  query: string,
  division?: string,
  limit = 20
): Promise<ParagraphSearchResult[]> {
  try {
    const params: unknown[] = [`%${query}%`, limit];
    let sql = `
      SELECT p.id AS "paragraphId", p.text, p.node_type AS "nodeType",
             s.id AS "specId",
             COALESCE(s.section, '') AS "specSection",
             COALESCE(s.title, '') AS "specTitle"
      FROM paragraphs p
      JOIN specs s ON p.spec_id = s.id
      WHERE p.text ILIKE $1`;
    if (division !== undefined) {
      params.push(`${division} %`);
      sql += ` AND s.section LIKE $${params.length}`;
    }
    sql += ` ORDER BY s.section, p.position LIMIT $2`;

    const result = await pool.query<ParagraphSearchResult>(sql, params);
    return result.rows;
  } catch (err) {
    throw new DatabaseError('searchParagraphs failed', { cause: err });
  }
}

export async function listCsiSections(division?: string): Promise<CsiSectionResult[]> {
  try {
    const params: unknown[] = [];
    let sql = `
      SELECT cs.section_number AS section, cs.title, cs.division,
             (s.id IS NOT NULL) AS "inDatabase"
      FROM csi_sections cs
      LEFT JOIN specs s ON s.section = cs.section_number`;
    if (division !== undefined) {
      params.push(division);
      sql += ` WHERE cs.division = $1`;
    }
    sql += ` ORDER BY cs.section_number`;

    const result = await pool.query<CsiSectionResult>(sql, params);
    return result.rows;
  } catch (err) {
    throw new DatabaseError('listCsiSections failed', { cause: err });
  }
}
```

- [ ] **Step 3.4: Run integration tests — expect PASS**

```bash
pnpm test:integration 2>&1 | grep -E "FAIL|PASS|search"
```

- [ ] **Step 3.5: Add re-exports to `src/db/index.ts`**

Append:

```typescript
export { searchParagraphs, listCsiSections } from './queries/search.js';
export type { ParagraphSearchResult, CsiSectionResult } from './queries/search.js';
```

- [ ] **Step 3.6: Lint + commit**

```bash
pnpm lint 2>&1 | grep "error" | head -20
git add src/db/queries/search.ts src/db/queries/search.integration.test.ts src/db/index.ts
git commit -m "feat(db): searchParagraphs + listCsiSections queries"
```

---

## Task 4: MCP Server Scaffold

**Files:**
- Create: `src/mcp/server.ts`
- Modify: `src/index.ts`

- [ ] **Step 4.1: Create `src/mcp/server.ts`**

```typescript
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express } from 'express';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { logger } from '../lib/logger.js';

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'specr', version: '0.1.0' });
  registerTools(server);
  registerResources(server);
  return server;
}

export function registerMcpRoutes(app: Express): void {
  app.post('/mcp', async (req, res) => {
    // AUTH HOOK: validate Authorization: Bearer <token> here before connecting transport.
    // Same token validation as REST middleware. Reject 401 if invalid.
    // Write tools especially depend on this gate — add when REST auth is implemented.
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('finish', () => {
        void transport.close();
      });
    } catch (err) {
      logger.error({ err }, 'mcp request failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal server error' });
      }
    }
  });

  // GET /mcp and DELETE /mcp: stubs for stateful session upgrade (Phase 5+).
  // In stateless mode these are unused — clients only POST.
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ error: 'stateless mode: SSE streams not supported' });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).json({ error: 'stateless mode: no sessions to terminate' });
  });
}
```

- [ ] **Step 4.2: Wire into `src/index.ts`**

Add import and call after existing router wiring:

```typescript
// Add this import at top of src/index.ts:
import { registerMcpRoutes } from './mcp/server.js';

// Add after app.use(router) and before app.use(errorHandler):
registerMcpRoutes(app);
```

The updated block in `src/index.ts` should look like:

```typescript
app.use(express.json());
app.use(router);
registerMcpRoutes(app);
app.use(errorHandler);
```

- [ ] **Step 4.3: Create stub `src/mcp/tools.ts`** (needed for server.ts to compile)

```typescript
// src/mcp/tools.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerTools(_server: McpServer): void {
  // Tools registered in subsequent tasks
}
```

- [ ] **Step 4.4: Create stub `src/mcp/resources.ts`** (needed for server.ts to compile)

```typescript
// src/mcp/resources.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerResources(_server: McpServer): void {
  // Resources registered in subsequent tasks
}
```

- [ ] **Step 4.5: Verify build compiles**

```bash
pnpm build 2>&1 | tail -10
```

Expected: exits 0, no TypeScript errors.

- [ ] **Step 4.6: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools.ts src/mcp/resources.ts src/index.ts
git commit -m "feat(mcp): server scaffold — stateless Streamable HTTP on Express"
```

---

## Task 5: MCP Tools

**Files:**
- Modify: `src/mcp/tools.ts`

- [ ] **Step 5.1: Implement all three tools**

Replace the stub content of `src/mcp/tools.ts`:

```typescript
// src/mcp/tools.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchParagraphs, listCsiSections, getSpecTree } from '../db/index.js';
import { logger } from '../lib/logger.js';

export function registerTools(server: McpServer): void {
  server.registerTool(
    'search_library',
    {
      description:
        'Search the CSI paragraph library by text content. Returns matching paragraphs with spec context (section, title, node type).',
      inputSchema: {
        query: z.string().min(1).describe('Text to search for in paragraph content'),
        division: z
          .string()
          .regex(/^\d{2}$/)
          .optional()
          .describe('Filter by 2-digit CSI division, e.g. "27"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Maximum results to return (1–100, default 20)'),
      },
    },
    async ({ query, division, limit }) => {
      try {
        const results = await searchParagraphs(query, division, limit ?? 20);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp tool search_library failed');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Internal error — search failed' }],
        };
      }
    }
  );

  server.registerTool(
    'get_spec',
    {
      description:
        'Return the full spec paragraph tree with cross-reference resolution status. Use references[].isResolved to check if referenced specs are loaded.',
      inputSchema: {
        specId: z.string().uuid().describe('Spec UUID (from search_library or list_sections)'),
      },
    },
    async ({ specId }) => {
      try {
        const result = await getSpecTree(specId);
        if (!result) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Spec not found: id=${specId}` }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp tool get_spec failed');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Internal error — spec retrieval failed' }],
        };
      }
    }
  );

  server.registerTool(
    'list_sections',
    {
      description:
        'List CSI MasterFormat sections with inDatabase flag. Use to discover which specs are loaded and identify library gaps.',
      inputSchema: {
        division: z
          .string()
          .regex(/^\d{2}$/)
          .optional()
          .describe('Filter by 2-digit CSI division, e.g. "27"'),
      },
    },
    async ({ division }) => {
      try {
        const sections = await listCsiSections(division);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(sections, null, 2) }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp tool list_sections failed');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Internal error — section list failed' }],
        };
      }
    }
  );
}
```

- [ ] **Step 5.2: Build to verify types**

```bash
pnpm build 2>&1 | tail -10
```

Expected: exits 0.

- [ ] **Step 5.3: Commit**

```bash
git add src/mcp/tools.ts
git commit -m "feat(mcp): register search_library, get_spec, list_sections tools"
```

---

## Task 6: MCP Resources

**Files:**
- Modify: `src/mcp/resources.ts`

- [ ] **Step 6.1: Implement both resources**

Replace stub content of `src/mcp/resources.ts`:

```typescript
// src/mcp/resources.ts
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSpecTree, listCsiSections } from '../db/index.js';
import { renderMarkdown } from '../generator/markdown.js';
import { logger } from '../lib/logger.js';

export function registerResources(server: McpServer): void {
  server.registerResource(
    'spec-tree',
    new ResourceTemplate('specr://specs/{id}', { list: undefined }),
    {
      description:
        'Full spec as LLM-readable Markdown with CSI hierarchy. Specifier notes rendered as > [NOTE] blockquotes.',
      mimeType: 'text/markdown',
    },
    async (uri, { id }) => {
      try {
        if (typeof id !== 'string') {
          return {
            contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Invalid spec id' }],
          };
        }
        const result = await getSpecTree(id);
        if (!result) {
          return {
            contents: [
              { uri: uri.href, mimeType: 'text/plain', text: `Spec not found: id=${id}` },
            ],
          };
        }
        return {
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderMarkdown(result.tree) }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp resource spec-tree failed');
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Internal error' }] };
      }
    }
  );

  server.registerResource(
    'csi-sections',
    'specr://sections',
    {
      description:
        'Full CSI MasterFormat section index as a Markdown table with inDatabase (✓) flag.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      try {
        const sections = await listCsiSections();
        const header = '| Section | Title | In DB |\n|---------|-------|-------|\n';
        const rows = sections
          .map((s) => `| ${s.section} | ${s.title} | ${s.inDatabase ? '✓' : ''} |`)
          .join('\n');
        return {
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text: header + rows }],
        };
      } catch (err) {
        logger.error({ err }, 'mcp resource csi-sections failed');
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Internal error' }] };
      }
    }
  );
}
```

- [ ] **Step 6.2: Build to verify types**

```bash
pnpm build 2>&1 | tail -10
```

Expected: exits 0.

- [ ] **Step 6.3: Commit**

```bash
git add src/mcp/resources.ts
git commit -m "feat(mcp): register specr://specs/{id} and specr://sections resources"
```

---

## Task 7: MCP Integration Tests

**Files:**
- Create: `src/mcp/server.integration.test.ts`

- [ ] **Step 7.1: Write integration tests**

```typescript
// src/mcp/server.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { pool } from '../db/index.js';
import { createSpec } from '../db/queries/specs.js';
import { insertTree } from '../db/queries/paragraphs.js';
import { registerMcpRoutes } from './server.js';

let server: Server;
let baseUrl: string;
let mcpSpecId: string;

// MCP JSON-RPC helper
async function mcpCall(
  url: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  return res.json();
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3001;
  baseUrl = `http://localhost:${port}`;

  mcpSpecId = await createSpec({ section: '27 21 00', title: 'MCP Test Spec', source: 'arcat' });
  await insertTree(
    {
      id: mcpSpecId,
      section: '27 21 00',
      title: 'MCP Test Spec',
      parts: [
        {
          id: '30000000-0000-0000-0000-000000000001',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '30000000-0000-0000-0000-000000000002',
              type: 'article',
              text: 'SCOPE',
              children: [
                {
                  id: '30000000-0000-0000-0000-000000000003',
                  type: 'pr1',
                  text: 'Provide fiber optic backbone cabling.',
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    },
    mcpSpecId,
    pool
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [mcpSpecId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /mcp — initialize', () => {
  it('responds to initialize request', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    const b = body as Record<string, unknown>;
    expect(b['jsonrpc']).toBe('2.0');
    const result = b['result'] as Record<string, unknown>;
    expect(result['serverInfo']).toBeDefined();
  });
});

describe('tool: search_library', () => {
  it('finds paragraphs by text', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'search_library',
      arguments: { query: 'fiber optic backbone' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    expect(content[0]!.type).toBe('text');
    const results = JSON.parse(content[0]!.text) as unknown[];
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns empty for no match', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'search_library',
      arguments: { query: 'xyznonexistent99999' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const results = JSON.parse(content[0]!.text) as unknown[];
    expect(results).toEqual([]);
  });
});

describe('tool: get_spec', () => {
  it('returns tree with parts', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec',
      arguments: { specId: mcpSpecId },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
    const tree = data['tree'] as Record<string, unknown>;
    expect(tree['id']).toBe(mcpSpecId);
    expect(Array.isArray(tree['parts'])).toBe(true);
  });

  it('returns isError for unknown id', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec',
      arguments: { specId: '00000000-0000-0000-0000-000000000000' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});

describe('tool: list_sections', () => {
  it('returns sections with inDatabase flag', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'list_sections',
      arguments: { division: '27' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const sections = JSON.parse(content[0]!.text) as { section: string; inDatabase: boolean }[];
    const loaded = sections.find((s) => s.section === '27 21 00');
    expect(loaded).toBeDefined();
    expect(loaded!.inDatabase).toBe(true);
  });
});

describe('resource: specr://specs/{id}', () => {
  it('returns spec as markdown', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'resources/read', {
      uri: `specr://specs/${mcpSpecId}`,
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const contents = result['contents'] as { mimeType: string; text: string }[];
    expect(contents[0]!.mimeType).toBe('text/markdown');
    expect(contents[0]!.text).toContain('# SECTION 27 21 00');
    expect(contents[0]!.text).toContain('## PART 1 - GENERAL');
  });
});

describe('resource: specr://sections', () => {
  it('returns section index as markdown table', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'resources/read', {
      uri: 'specr://sections',
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const contents = result['contents'] as { mimeType: string; text: string }[];
    expect(contents[0]!.mimeType).toBe('text/markdown');
    expect(contents[0]!.text).toContain('| Section |');
    expect(contents[0]!.text).toContain('27 21 00');
  });
});

describe('GET /mcp', () => {
  it('returns 405 in stateless mode', async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 7.2: Run integration tests — expect PASS**

```bash
pnpm test:integration 2>&1 | grep -E "FAIL|PASS|mcp"
```

Expected: all MCP integration tests pass.

- [ ] **Step 7.3: Run full test suite**

```bash
pnpm test && pnpm test:integration
```

Expected: all tests pass (no regressions).

- [ ] **Step 7.4: Lint**

```bash
pnpm lint
```

Expected: exits 0.

- [ ] **Step 7.5: Commit**

```bash
git add src/mcp/server.integration.test.ts
git commit -m "test(mcp): integration tests — tools, resources, initialize"
```

---

## Task 8: Claude Code Config + Verify End-to-End

- [ ] **Step 8.1: Start dev server**

```bash
pnpm dev
```

- [ ] **Step 8.2: Add MCP server to Claude Code config**

Create or update `.mcp.json` in the repo root:

```json
{
  "mcpServers": {
    "specr": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

- [ ] **Step 8.3: Smoke test with curl**

Send an initialize request to verify the server responds:

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' \
  | jq '.result.serverInfo'
```

Expected output:
```json
{
  "name": "specr",
  "version": "0.1.0"
}
```

- [ ] **Step 8.4: Final commit**

```bash
git add .mcp.json
git commit -m "chore: add .mcp.json for local Claude Code integration"
```

---

## Definition of Done

- [ ] All unit tests pass: `pnpm test`
- [ ] All integration tests pass: `pnpm test:integration`
- [ ] `pnpm lint` exits 0
- [ ] `pnpm build` exits 0
- [ ] `POST /mcp` responds to `initialize` requests
- [ ] `search_library`, `get_spec`, `list_sections` tools return structured JSON
- [ ] `specr://specs/{id}` resource returns Markdown with correct CSI hierarchy
- [ ] `specr://sections` resource returns Markdown table with `inDatabase` flag
- [ ] Auth hook comment present in `src/mcp/server.ts` at the right insertion point
