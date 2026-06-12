# Spec Lineage Surfacing (Issue #97) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the ADR-015 D6 chain of custody read-only: `GET /specs/:id/lineage` and MCP tool `get_spec_lineage` walk `parent_spec_id` to the root and report per-hop drift (`behindBy`).

**Architecture:** One new DB query module (`src/db/queries/lineage.ts`) does a recursive CTE walk over `specs.parent_spec_id` (cycle-guarded), joining `libraries`/`projects` for scope+name and the parent row for its current `content_version`. The API handler and MCP handler are thin wrappers returning the same payload. No migration — columns exist (migration 017/016).

**Tech Stack:** TypeScript/Node 22, Express, pg recursive CTE, Zod v4 (`z.uuid()`), MCP SDK, vitest integration project against real PostgreSQL.

---

## Locked design decisions (document in PR)

1. **Chain order:** index 0 = the requested spec (leaf), last = root. Matches "walking `parent_spec_id` to the root".
2. **`scope`:** derived from the `specs_owner_xor` constraint — `project_id IS NOT NULL` → `'project'`, else `'library'`. `name` = owning project's or library's `name`.
3. **`behindBy` semantics (ADR-015 D2/D6):** per hop, `parent.content_version − hop.origin_version` — how many content bumps the parent has accumulated since this copy was cloned. Root hop (no parent) → `behindBy: null`, `originVersion: null`. Defensive: if a parent exists but `origin_version` is NULL (not produced by any clone path), `behindBy: null` rather than a fabricated number.
4. **`originMeta`:** the **root** hop's `origin_meta` (ingest provenance is the chain origin per the acceptance criterion). `null` when the root was never ingested from a file.
5. **Cycle guard:** recursive CTE carries a `path uuid[]`; recursion stops when an id repeats. A cycle is data corruption, not a user error — the walk terminates and returns what it has.
6. **404** for unknown spec id (API) / `isError` (MCP) — same pattern as `get_spec`.
7. **`behindBy` reads the parent's *current* content_version even if the parent left the chain context** — i.e. it is computed per stored edge, no recomputation against grandparents.

## File structure

- Create: `src/db/queries/lineage.ts` — `getSpecLineage(id)` + types `LineageHop`, `SpecLineage`, `LineageScope`
- Create: `src/db/queries/lineage.integration.test.ts` — three-hop fixture + ingested-root tests
- Modify: `src/db/index.ts` — barrel exports
- Modify: `src/api/specs.ts` — `getSpecLineageHandler`
- Modify: `src/api/router.ts` — `GET /specs/:id/lineage`
- Create: `src/api/lineage.integration.test.ts` — endpoint tests (own fixture; keeps specs.integration.test.ts within budget)
- Modify: `src/mcp/handlers.ts` — `handleGetSpecLineage`
- Modify: `src/mcp/tools.ts` — register `get_spec_lineage` in `registerSpecTools`
- Modify: `src/mcp/server.integration.test.ts` — JSON-RPC `tools/call` test
- Modify: `openapi.yaml` — contract for the new endpoint

---

### Task 1: DB query — `getSpecLineage`

**Files:**
- Create: `src/db/queries/lineage.ts`
- Create: `src/db/queries/lineage.integration.test.ts`
- Modify: `src/db/index.ts`

- [ ] **Step 1: Write the failing integration test**

`src/db/queries/lineage.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { getSpecLineage } from './lineage.js';

const ORIGIN_META = {
  filename: 'lineage-fixture.sec',
  sha256: 'a'.repeat(64),
  loader: 'test:lineage-fixture',
};

let companyLibId: string;
let clientLibId: string;
let projectId: string;
let rootSpecId: string;
let clientSpecId: string;
let projectSpecId: string;
let bareSpecId: string;

async function insertLibrary(tier: string, name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ($1, $2) RETURNING id`,
    [tier, name]
  );
  const row = res.rows[0];
  if (!row) throw new Error('library insert failed');
  return row.id;
}

beforeAll(async () => {
  companyLibId = await insertLibrary('company', 'Lineage Co Master (#97)');
  clientLibId = await insertLibrary('client', 'Lineage Client Master (#97)');
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('Lineage Project (#97)') RETURNING id`
  );
  const projRow = proj.rows[0];
  if (!projRow) throw new Error('project insert failed');
  projectId = projRow.id;

  // Root: ingested company master, drifted to content_version 5.
  const root = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, content_version, origin_meta)
     VALUES ('27 21 97', 'Lineage Root', 'docx', $1, 5, $2::jsonb) RETURNING id`,
    [companyLibId, JSON.stringify(ORIGIN_META)]
  );
  rootSpecId = root.rows[0]?.id ?? '';

  // Client master copy cloned at parent content_version 3; parent is now at 5.
  const client = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, parent_spec_id,
                        origin_version, content_version, origin_meta)
     VALUES ('27 21 97', 'Lineage Client Copy', 'docx', $1, $2, 3, 2, $3::jsonb) RETURNING id`,
    [clientLibId, rootSpecId, JSON.stringify(ORIGIN_META)]
  );
  clientSpecId = client.rows[0]?.id ?? '';

  // Project copy cloned at client content_version 1; client is now at 2.
  const projSpec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id, parent_spec_id,
                        origin_version, content_version, origin_meta)
     VALUES ('27 21 97', 'Lineage Project Copy', 'docx', $1, $2, 1, 4, $3::jsonb) RETURNING id`,
    [projectId, clientSpecId, JSON.stringify(ORIGIN_META)]
  );
  projectSpecId = projSpec.rows[0]?.id ?? '';

  // Bare master: never ingested from a file, no lineage.
  const bare = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 22 97', 'Lineage Bare Master', 'docx', $1) RETURNING id`,
    [companyLibId]
  );
  bareSpecId = bare.rows[0]?.id ?? '';
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [
    [projectSpecId, clientSpecId, rootSpecId, bareSpecId].filter(Boolean),
  ]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [
    [companyLibId, clientLibId],
  ]);
});

describe('getSpecLineage (integration)', () => {
  it('three-hop chain (company → client → project) reports scope, name, versions, behindBy', async () => {
    const lineage = await getSpecLineage(projectSpecId);
    expect(lineage).not.toBeNull();
    expect(lineage?.chain).toHaveLength(3);

    const [leaf, mid, root] = lineage?.chain ?? [];
    expect(leaf).toEqual({
      specId: projectSpecId,
      scope: 'project',
      name: 'Lineage Project (#97)',
      contentVersion: 4,
      originVersion: 1,
      behindBy: 1, // client copy is at 2, cloned at 1
    });
    expect(mid).toEqual({
      specId: clientSpecId,
      scope: 'library',
      name: 'Lineage Client Master (#97)',
      contentVersion: 2,
      originVersion: 3,
      behindBy: 2, // root is at 5, cloned at 3
    });
    expect(root).toEqual({
      specId: rootSpecId,
      scope: 'library',
      name: 'Lineage Co Master (#97)',
      contentVersion: 5,
      originVersion: null,
      behindBy: null,
    });
  });

  it('ingested-root spec returns origin_meta as the chain origin', async () => {
    const lineage = await getSpecLineage(rootSpecId);
    expect(lineage?.chain).toHaveLength(1);
    expect(lineage?.chain[0]?.behindBy).toBeNull();
    expect(lineage?.originMeta).toEqual(ORIGIN_META);
  });

  it('derived spec also surfaces the root origin_meta', async () => {
    const lineage = await getSpecLineage(projectSpecId);
    expect(lineage?.originMeta).toEqual(ORIGIN_META);
  });

  it('spec with no lineage and no ingest provenance returns single hop, null originMeta', async () => {
    const lineage = await getSpecLineage(bareSpecId);
    expect(lineage?.chain).toHaveLength(1);
    expect(lineage?.originMeta).toBeNull();
  });

  it('returns null for unknown spec id', async () => {
    const lineage = await getSpecLineage('00000000-0000-0000-0000-000000000000');
    expect(lineage).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5446/specr pnpm test:integration -- src/db/queries/lineage.integration.test.ts`
Expected: FAIL — `Cannot find module './lineage.js'`

- [ ] **Step 3: Implement `src/db/queries/lineage.ts`**

```typescript
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import type { OriginMeta } from './specs.js';

/** ADR-015 D6 — read-only custody chain. Walks specs.parent_spec_id to the
 *  root; per-hop drift (behindBy) = parent's current content_version minus
 *  this copy's clone-time origin_version (ADR-015 D2). */

export type LineageScope = 'library' | 'project';

export interface LineageHop {
  readonly specId: string;
  readonly scope: LineageScope;
  readonly name: string;
  readonly contentVersion: number;
  readonly originVersion: number | null;
  readonly behindBy: number | null;
}

export interface SpecLineage {
  readonly chain: readonly LineageHop[];
  /** Ingest provenance of the chain root; null when the root was never file-ingested. */
  readonly originMeta: OriginMeta | null;
}

interface LineageRow {
  readonly id: string;
  readonly scope: LineageScope;
  readonly name: string;
  readonly content_version: number;
  readonly origin_version: number | null;
  readonly origin_meta: OriginMeta | null;
  readonly parent_content_version: number | null;
}

function toHop(row: LineageRow): LineageHop {
  const behindBy =
    row.parent_content_version !== null && row.origin_version !== null
      ? row.parent_content_version - row.origin_version
      : null;
  return {
    specId: row.id,
    scope: row.scope,
    name: row.name,
    contentVersion: row.content_version,
    originVersion: row.origin_version,
    behindBy,
  };
}

/** Walk the derivation chain from `id` to its root. Returns null when the
 *  spec does not exist. The recursive walk is cycle-guarded (path array) —
 *  a corrupt self-referencing chain terminates instead of looping. */
export async function getSpecLineage(id: string): Promise<SpecLineage | null> {
  try {
    const result = await pool.query<LineageRow>(
      `WITH RECURSIVE chain AS (
         SELECT s.id, s.parent_spec_id, s.origin_version, s.content_version,
                s.origin_meta, s.library_id, s.project_id,
                0 AS depth, ARRAY[s.id] AS path
         FROM specs s WHERE s.id = $1
         UNION ALL
         SELECT p.id, p.parent_spec_id, p.origin_version, p.content_version,
                p.origin_meta, p.library_id, p.project_id,
                c.depth + 1, c.path || p.id
         FROM specs p
         JOIN chain c ON p.id = c.parent_spec_id
         WHERE NOT p.id = ANY(c.path)
       )
       SELECT c.id,
              CASE WHEN c.project_id IS NOT NULL THEN 'project' ELSE 'library' END AS scope,
              COALESCE(pr.name, l.name, '') AS name,
              c.content_version, c.origin_version, c.origin_meta,
              parent.content_version AS parent_content_version
       FROM chain c
       LEFT JOIN libraries l ON l.id = c.library_id
       LEFT JOIN projects pr ON pr.id = c.project_id
       LEFT JOIN specs parent ON parent.id = c.parent_spec_id
       ORDER BY c.depth`,
      [id]
    );
    if (result.rows.length === 0) return null;
    const chain = result.rows.map(toHop);
    const root = result.rows[result.rows.length - 1];
    return { chain, originMeta: root?.origin_meta ?? null };
  } catch (err) {
    throw new DatabaseError('getSpecLineage failed', { cause: err });
  }
}
```

- [ ] **Step 4: Export from the barrel** — `src/db/index.ts`, after the derive exports:

```typescript
export { getSpecLineage } from './queries/lineage.js';
export type { SpecLineage, LineageHop, LineageScope } from './queries/lineage.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5446/specr pnpm test:integration -- src/db/queries/lineage.integration.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Lint + commit**

```bash
pnpm lint
git add src/db/queries/lineage.ts src/db/queries/lineage.integration.test.ts src/db/index.ts
git commit -m "feat(db): getSpecLineage — recursive custody-chain walk with behindBy drift (ADR-015 D6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: API endpoint — `GET /specs/:id/lineage`

**Files:**
- Modify: `src/api/specs.ts`
- Modify: `src/api/router.ts`
- Create: `src/api/lineage.integration.test.ts`
- Modify: `openapi.yaml`

- [ ] **Step 1: Write the failing integration test**

`src/api/lineage.integration.test.ts` — same express harness as `specs.integration.test.ts`; fixture mirrors Task 1 (two libraries + project + 3 chained specs, distinct names suffixed `(api #97)` to avoid unique-name collisions):

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

const ORIGIN_META = {
  filename: 'lineage-api-fixture.sec',
  sha256: 'b'.repeat(64),
  loader: 'test:lineage-api-fixture',
};

let server: Server;
let baseUrl: string;
let companyLibId: string;
let clientLibId: string;
let projectId: string;
let rootSpecId: string;
let clientSpecId: string;
let projectSpecId: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;

  const co = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', 'Lineage Co (api #97)') RETURNING id`
  );
  companyLibId = co.rows[0]?.id ?? '';
  const cl = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('client', 'Lineage Client (api #97)') RETURNING id`
  );
  clientLibId = cl.rows[0]?.id ?? '';
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('Lineage Project (api #97)') RETURNING id`
  );
  projectId = proj.rows[0]?.id ?? '';

  const root = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, content_version, origin_meta)
     VALUES ('27 23 97', 'Root', 'docx', $1, 5, $2::jsonb) RETURNING id`,
    [companyLibId, JSON.stringify(ORIGIN_META)]
  );
  rootSpecId = root.rows[0]?.id ?? '';
  const client = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, parent_spec_id,
                        origin_version, content_version)
     VALUES ('27 23 97', 'Client copy', 'docx', $1, $2, 3, 2) RETURNING id`,
    [clientLibId, rootSpecId]
  );
  clientSpecId = client.rows[0]?.id ?? '';
  const projSpec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id, parent_spec_id,
                        origin_version, content_version)
     VALUES ('27 23 97', 'Project copy', 'docx', $1, $2, 1, 4) RETURNING id`,
    [projectId, clientSpecId]
  );
  projectSpecId = projSpec.rows[0]?.id ?? '';
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [
    [projectSpecId, clientSpecId, rootSpecId].filter(Boolean),
  ]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [
    [companyLibId, clientLibId],
  ]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('GET /specs/:id/lineage (integration)', () => {
  it('returns the full three-hop chain with behindBy and root originMeta', async () => {
    const res = await fetch(`${baseUrl}/specs/${projectSpecId}/lineage`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);
    const data = body['data'] as { chain: Record<string, unknown>[]; originMeta: unknown };
    expect(data.chain).toHaveLength(3);
    expect(data.chain[0]).toEqual({
      specId: projectSpecId,
      scope: 'project',
      name: 'Lineage Project (api #97)',
      contentVersion: 4,
      originVersion: 1,
      behindBy: 1,
    });
    expect(data.chain[1]?.['behindBy']).toBe(2);
    expect(data.chain[2]?.['specId']).toBe(rootSpecId);
    expect(data.chain[2]?.['behindBy']).toBeNull();
    expect(data.originMeta).toEqual(ORIGIN_META);
  });

  it('returns 404 for unknown UUID', async () => {
    const res = await fetch(`${baseUrl}/specs/00000000-0000-0000-0000-000000000000/lineage`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['success']).toBe(false);
    expect(body['error']).toBe('spec not found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5446/specr pnpm test:integration -- src/api/lineage.integration.test.ts`
Expected: FAIL — 404 (route not registered) on the first test

- [ ] **Step 3: Add handler to `src/api/specs.ts`** (import `getSpecLineage` from `'../db/index.js'`):

```typescript
export async function getSpecLineageHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  try {
    const lineage = await getSpecLineage(id);
    if (!lineage) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: lineage });
  } catch (err) {
    logger.error({ err }, 'get spec lineage failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

- [ ] **Step 4: Register the route in `src/api/router.ts`** (after the `GET /specs/:id` line):

```typescript
router.get('/specs/:id/lineage', getSpecLineageHandler);
```

(and add `getSpecLineageHandler` to the import from `./specs.js`)

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5446/specr pnpm test:integration -- src/api/lineage.integration.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Update `openapi.yaml`** — add under `paths`, mirroring the `/specs/{id}` style of the existing file:

```yaml
  /specs/{id}/lineage:
    get:
      summary: Chain of custody for a spec
      description: >
        Walks parent_spec_id from the requested spec to its root (ADR-015 D6).
        chain[0] is the requested spec; the last entry is the root. Per hop,
        behindBy = parent's current contentVersion − this copy's originVersion
        (null on the root). originMeta is the root's ingest provenance.
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: Lineage chain
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean }
                  data:
                    type: object
                    properties:
                      chain:
                        type: array
                        items:
                          type: object
                          properties:
                            specId: { type: string, format: uuid }
                            scope: { type: string, enum: [library, project] }
                            name: { type: string }
                            contentVersion: { type: integer }
                            originVersion: { type: integer, nullable: true }
                            behindBy: { type: integer, nullable: true }
                      originMeta:
                        type: object
                        nullable: true
                        properties:
                          filename: { type: string }
                          sha256: { type: string }
                          loader: { type: string }
        '404':
          description: Spec not found
```

(Adjust field style to match the existing document's conventions exactly — read it before editing.)

- [ ] **Step 7: Lint + commit**

```bash
pnpm lint
git add src/api/specs.ts src/api/router.ts src/api/lineage.integration.test.ts openapi.yaml
git commit -m "feat(api): GET /specs/:id/lineage — chain-of-custody endpoint (ADR-015 D6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: MCP tool — `get_spec_lineage`

**Files:**
- Modify: `src/mcp/handlers.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.integration.test.ts`

- [ ] **Step 1: Write the failing JSON-RPC integration test** — append to `src/mcp/server.integration.test.ts`. The suite's beforeAll already creates `mcpSpecId`; add a derived clone in the new describe's own beforeAll/afterAll (project + clone referencing `mcpSpecId`):

```typescript
describe('tool: get_spec_lineage (#97)', () => {
  let lineageProjectId: string;
  let lineageCloneId: string;

  beforeAll(async () => {
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('Lineage Project (mcp #97)') RETURNING id`
    );
    lineageProjectId = proj.rows[0]?.id ?? '';
    const clone = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, project_id, parent_spec_id,
                          origin_version, content_version)
       SELECT s.section, s.title, s.source, $1, s.id, s.content_version, 1
       FROM specs s WHERE s.id = $2 RETURNING id`,
      [lineageProjectId, mcpSpecId]
    );
    lineageCloneId = clone.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [lineageCloneId]);
    await pool.query('DELETE FROM projects WHERE id = $1', [lineageProjectId]);
  });

  it('returns the custody chain via tools/call', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec_lineage',
      arguments: { specId: lineageCloneId },
    });
    const b = body as {
      result: { isError?: boolean; content: { type: string; text: string }[] };
    };
    expect(b.result.isError).toBeUndefined();
    const payload = JSON.parse(b.result.content[0]?.text ?? '{}') as {
      chain: { specId: string; scope: string; behindBy: number | null }[];
      originMeta: unknown;
    };
    expect(payload.chain).toHaveLength(2);
    expect(payload.chain[0]?.specId).toBe(lineageCloneId);
    expect(payload.chain[0]?.scope).toBe('project');
    expect(payload.chain[0]?.behindBy).toBe(0); // cloned at the parent's current version
    expect(payload.chain[1]?.specId).toBe(mcpSpecId);
    expect(payload.chain[1]?.behindBy).toBeNull();
  });

  it('returns isError for unknown UUID', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec_lineage',
      arguments: { specId: '00000000-0000-0000-0000-000000000000' },
    });
    const b = body as { result: { isError?: boolean } };
    expect(b.result.isError).toBe(true);
  });
});
```

Note: `behindBy: 0` assumes no earlier test bumped `mcpSpecId`'s content_version after the clone — the clone is created in this describe's beforeAll, which runs after suite setup; if another suite-ordered test PATCHes the spec, clone at beforeAll time still snapshots the *current* version, so 0 holds unless a later test mutates it before this describe runs. If flaky, assert `expect(payload.chain[0]?.behindBy).toBeGreaterThanOrEqual(0)` and add a comment.

- [ ] **Step 2: Run to verify failure**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5446/specr pnpm test:integration -- src/mcp/server.integration.test.ts -t get_spec_lineage`
Expected: FAIL — tool not found / isError

- [ ] **Step 3: Handler in `src/mcp/handlers.ts`** (add `getSpecLineage` to the existing `../db/index.js` import):

```typescript
export async function handleGetSpecLineage({ specId }: { specId: string }): Promise<ToolResult> {
  try {
    const lineage = await getSpecLineage(specId);
    if (!lineage) {
      return toolError(`Spec not found: id=${specId}`);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(lineage, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool get_spec_lineage failed');
    return toolError('Internal error — lineage retrieval failed');
  }
}
```

- [ ] **Step 4: Register in `src/mcp/tools.ts`** → `registerSpecTools` (import `handleGetSpecLineage` from `./handlers.js`):

```typescript
server.registerTool(
  'get_spec_lineage',
  {
    description:
      'Audit the chain of custody for a spec (ADR-015 D6). Walks parent_spec_id from the spec to its root master: chain[0] is the requested spec, the last entry is the root. Per hop, behindBy = parent’s current contentVersion minus this copy’s originVersion (drift since clone; null on the root). originMeta is the root’s ingest provenance (filename, sha256, loader) or null.',
    inputSchema: {
      specId: z.uuid().describe('Spec UUID (from search_library, list_sections, or get_spec)'),
    },
  },
  handleGetSpecLineage
);
```

- [ ] **Step 5: Run to verify pass**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5446/specr pnpm test:integration -- src/mcp/server.integration.test.ts`
Expected: PASS (whole suite — verify no rate-limit/regression fallout)

- [ ] **Step 6: Lint + commit**

```bash
pnpm lint
git add src/mcp/handlers.ts src/mcp/tools.ts src/mcp/server.integration.test.ts
git commit -m "feat(mcp): get_spec_lineage tool — custody-chain audit for agents (ADR-015 D6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Full verification + PR

- [ ] `pnpm lint` — clean
- [ ] `pnpm test` — unit suite green
- [ ] `DATABASE_URL=postgres://specr:specr@localhost:5446/specr pnpm test:integration` — full integration suite green
- [ ] Push branch, open PR: `feat(api): chain-of-custody surfacing — lineage endpoint + MCP tool` with `Closes #97`, a "## Design decisions" section (chain order, behindBy semantics, originMeta=root, cycle guard, scope derivation), Testing checkboxes, and the Fable 5 credit trailer.
