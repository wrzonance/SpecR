# Design Packages (Issue #95) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement ADR-015 D4 — design packages as named, ordered subsets of a project's TOC, with migration 020, query layer, and REST endpoints.

**Architecture:** Two new tables (`design_packages`, `package_specs`) exactly per ADR-015 D4. Same-project membership is enforced at the query layer (the migration-018 precedent: cross-table CHECKs would need triggers). REST follows the established projects.ts/derive.ts patterns: Zod-validated bodies, typed error classes mapped to HTTP statuses, `pgErrorToHttp` for constraint violations, all DB access through the `src/db/index.ts` barrel.

**Tech Stack:** TypeScript strict, Express, node-pg-migrate (TS migrations), pg, Zod v4 (`z.uuid()`, `.check()`), vitest integration tests against PostgreSQL on port 5434.

**Out of scope:** Issuance snapshots (`package_revisions`, next issue), manual rendering (ADR-017), MCP tools for packages, package rename/reorder endpoints (PATCH), pagination.

## Design decisions (document in PR body)

1. **Same-project membership enforced at query layer**, not a DB trigger — mirrors migration 018's tier-restriction precedent. Migration comment documents this.
2. **`PUT /packages/:id/specs` is full replacement** — body `{ specIds: [...] }`; position = array index + 1; empty array clears the package. Idempotent, matches "ordered membership" semantics with no patch-language complexity.
3. **Package `position` auto-assigned `MAX+1` per project** (same as TOC `insertTocEntry`). No reorder endpoint yet (YAGNI — not in issue scope).
4. **`package_specs.spec_id ON DELETE RESTRICT`** (per ADR) means `DELETE /projects/:id/specs/:specId` now fails for a spec still in a package. The handler maps pg 23503 → 409 with an actionable message — without this the migration would introduce a 500 on an existing endpoint.
5. **`CHECK (position >= 1)`** added on both tables — consistent with `project_sources_priority_check` (migration 018); not in the ADR sketch but pure hardening.
6. **404 vs 422 surfaces:** unknown project/package → 404; spec not in the package's project TOC (including unknown spec ids) → 422 listing the offending ids.

## File map

- Create: `src/db/migrations/020_create_design_packages.ts`
- Create: `src/db/queries/packages.ts`
- Create: `src/api/packages.ts`
- Create: `src/api/packages.integration.test.ts`
- Modify: `src/ast/schemas.ts` (two body schemas, after `AddSectionToProjectBodySchema` ~line 115)
- Modify: `src/ast/schemas.test.ts` (schema unit tests, append)
- Modify: `src/ast/index.ts` (export new schemas/types)
- Modify: `src/db/index.ts` (barrel re-exports, append)
- Modify: `src/api/router.ts` (four routes)
- Modify: `src/api/projects.ts` (`removeSectionFromProjectHandler` 23503 → 409)
- Modify: `openapi.yaml` (four endpoints + component schemas)

---

### Task 0: Test database

- [ ] **Step 1: Start isolated PostgreSQL on 5434 and migrate + seed**

```bash
docker run --rm -d --name specr-pg-95 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=specr -p 5434:5432 postgres:16
sleep 3
cd /home/adam/github/SpecR/.worktrees/feat/issue-95
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm seed
```

Expected: migrations 001–019 apply, seed completes.

---

### Task 1: Migration 020 — `design_packages` + `package_specs`

**Files:**
- Create: `src/db/migrations/020_create_design_packages.ts`

- [ ] **Step 1: Write the migration**

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D4 — design packages: named, ordered, issuable subsets of the
// project TOC. A project issues multiple packages (bid packages, early
// releases, CD sets); one spec may belong to several packages.
// package_specs.spec_id is RESTRICT: a spec cannot be deleted out from under
// a package — remove it from its packages (or delete the package) first.
//
// Same-project membership (a package may only hold specs from its own
// project's TOC) is enforced at the query layer
// (src/db/queries/packages.ts) — a cross-table CHECK against
// design_packages.project_id would require a trigger (same pattern as the
// project_sources tier restriction, migration 018).

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('design_packages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
  });
  pgm.addConstraint(
    'design_packages',
    'design_packages_project_name_unique',
    'UNIQUE (project_id, name)'
  );
  pgm.addConstraint('design_packages', 'design_packages_position_check', {
    check: 'position >= 1',
  });

  pgm.createTable('package_specs', {
    package_id: {
      type: 'uuid',
      notNull: true,
      references: 'design_packages',
      onDelete: 'CASCADE',
    },
    spec_id: { type: 'uuid', notNull: true, references: 'specs', onDelete: 'RESTRICT' },
    position: { type: 'integer', notNull: true },
  });
  pgm.addConstraint('package_specs', 'package_specs_pkey', 'PRIMARY KEY (package_id, spec_id)');
  pgm.addConstraint('package_specs', 'package_specs_position_check', {
    check: 'position >= 1',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('package_specs');
  pgm.dropTable('design_packages');
};
```

- [ ] **Step 2: Verify up/down/up clean** (acceptance criterion)

```bash
cd /home/adam/github/SpecR/.worktrees/feat/issue-95
export DB='DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test'
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate:down
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
```

Expected: `020_create_design_packages` applies, rolls back without error, re-applies. Then confirm tables exist:

```bash
docker exec specr-pg-95 psql -U postgres -d specr -c '\d design_packages' -c '\d package_specs'
```

Expected: both tables with the constraints above.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/020_create_design_packages.ts
git commit -m "feat(db): migration 020 — design_packages + package_specs (ADR-015 D4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Request body schemas (TDD)

**Files:**
- Modify: `src/ast/schemas.test.ts` (append at end)
- Modify: `src/ast/schemas.ts` (after `AddSectionToProjectBodySchema`, ~line 115)
- Modify: `src/ast/index.ts`

- [ ] **Step 1: Write the failing tests** — append to `src/ast/schemas.test.ts` (add `CreatePackageBodySchema, SetPackageSpecsBodySchema` to the existing import from `'./schemas.js'`):

```typescript
describe('CreatePackageBodySchema (issue #95)', () => {
  it('accepts a non-empty name', () => {
    expect(CreatePackageBodySchema.safeParse({ name: 'Early Steel Release' }).success).toBe(true);
  });
  it('rejects empty and missing name', () => {
    expect(CreatePackageBodySchema.safeParse({ name: '' }).success).toBe(false);
    expect(CreatePackageBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('SetPackageSpecsBodySchema (issue #95)', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  it('accepts an ordered uuid array', () => {
    expect(SetPackageSpecsBodySchema.safeParse({ specIds: [a, b] }).success).toBe(true);
  });
  it('accepts an empty array (clears the package)', () => {
    expect(SetPackageSpecsBodySchema.safeParse({ specIds: [] }).success).toBe(true);
  });
  it('rejects duplicates, non-uuids, and missing specIds', () => {
    expect(SetPackageSpecsBodySchema.safeParse({ specIds: [a, a] }).success).toBe(false);
    expect(SetPackageSpecsBodySchema.safeParse({ specIds: ['nope'] }).success).toBe(false);
    expect(SetPackageSpecsBodySchema.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test -- src/ast/schemas.test.ts
```

Expected: FAIL — `CreatePackageBodySchema` is not exported.

- [ ] **Step 3: Implement schemas** — append to `src/ast/schemas.ts` directly after `AddSectionToProjectBody` (~line 115):

```typescript
export const CreatePackageBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
});

export type CreatePackageBody = z.infer<typeof CreatePackageBodySchema>;

// Full-replacement ordered membership (position = array order, 1-based).
// Empty array clears the package. Same-project restriction is enforced at
// the query layer (ADR-015 D4, issue #95).
export const SetPackageSpecsBodySchema = z.object({
  specIds: z.array(z.uuid()).check((ctx) => {
    if (new Set(ctx.value).size !== ctx.value.length) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'specIds must not contain duplicates',
      });
    }
  }),
});

export type SetPackageSpecsBody = z.infer<typeof SetPackageSpecsBodySchema>;
```

And in `src/ast/index.ts`, extend the existing project-schema export block:

```typescript
export {
  NodeTypeSchema,
  SignalConflictSchema,
  SpecNodeMetaSchema,
  SpecNodeSchema,
  SpecTreeSchema,
  SecRefSchema,
  PatchSpecBodySchema,
  CreateProjectBodySchema,
  AddSectionToProjectBodySchema,
  CreatePackageBodySchema,
  SetPackageSpecsBodySchema,
} from './schemas.js';
export type {
  CreateProjectBody,
  AddSectionToProjectBody,
  CreatePackageBody,
  SetPackageSpecsBody,
} from './schemas.js';
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm test -- src/ast/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ast/schemas.ts src/ast/schemas.test.ts src/ast/index.ts
git commit -m "feat(ast): CreatePackageBody + SetPackageSpecs request schemas (issue #95)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: API integration tests (red)

**Files:**
- Create: `src/api/packages.integration.test.ts`

Follow the fixture/cleanup conventions of `src/api/projects.integration.test.ts`. Sections `05 12 00` / `23 09 23` are unused by other test files (verified by grep).

- [ ] **Step 1: Write the failing integration test file**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

const ZERO = '00000000-0000-0000-0000-000000000000';

let server: Server;
let baseUrl: string;
let companyId: string;
const projectIds: string[] = [];
const masterIds: string[] = [];
let p1: string; // project under test
let p2: string; // second project — cross-project membership must be rejected
let steel1: string; // P1 clone of 05 12 00
let hvac1: string; // P1 clone of 23 09 23
let steel2: string; // P2 clone of 05 12 00

async function json(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function data(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
}

async function insertMaster(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, title, companyId]
  );
  const row = r.rows[0];
  if (!row) throw new Error(`failed to insert master ${section}`);
  masterIds.push(row.id);
  return row.id;
}

async function createProjectWithSections(
  name: string,
  sections: readonly string[]
): Promise<{ projectId: string; specIds: string[] }> {
  const created = await json('POST', '/projects', { name, sourceLibraryIds: [companyId] });
  const projectId = (await data(created))['projectId'] as string;
  projectIds.push(projectId);
  const specIds: string[] = [];
  for (const section of sections) {
    const added = await json('POST', `/projects/${projectId}/specs`, { section });
    specIds.push((await data(added))['specId'] as string);
  }
  return { projectId, specIds };
}

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
  baseUrl = `http://localhost:${typeof address === 'object' && address !== null ? address.port : 3000}`;
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master'`
  );
  if (!lib.rows[0]) throw new Error('Default Company Master missing — run migrations');
  companyId = lib.rows[0].id;
  await insertMaster('05 12 00', 'Structural Steel Framing');
  await insertMaster('23 09 23', 'Direct Digital Control');
  const proj1 = await createProjectWithSections(`Pkg API P1 ${Date.now()}`, [
    '05 12 00',
    '23 09 23',
  ]);
  p1 = proj1.projectId;
  [steel1, hvac1] = proj1.specIds as [string, string];
  const proj2 = await createProjectWithSections(`Pkg API P2 ${Date.now()}`, ['05 12 00']);
  p2 = proj2.projectId;
  [steel2] = proj2.specIds as [string];
});

afterAll(async () => {
  // packages cascade their package_specs; clones must be unhooked before specs delete
  await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [masterIds]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /projects/:id/packages', () => {
  it('creates packages with auto-incrementing position', async () => {
    const res1 = await json('POST', `/projects/${p1}/packages`, { name: 'Early Steel Release' });
    expect(res1.status).toBe(201);
    const d1 = await data(res1);
    expect(typeof d1['packageId']).toBe('string');
    expect(d1['name']).toBe('Early Steel Release');
    expect(d1['position']).toBe(1);
    const res2 = await json('POST', `/projects/${p1}/packages`, { name: '100% CD Set' });
    expect((await data(res2))['position']).toBe(2);
  });

  it('409 on duplicate name within the project', async () => {
    const res = await json('POST', `/projects/${p1}/packages`, { name: 'Early Steel Release' });
    expect(res.status).toBe(409);
  });

  it('404 for unknown project', async () => {
    const res = await json('POST', `/projects/${ZERO}/packages`, { name: 'X' });
    expect(res.status).toBe(404);
  });

  it('422 for empty name', async () => {
    const res = await json('POST', `/projects/${p1}/packages`, { name: '' });
    expect(res.status).toBe(422);
  });
});

describe('PUT /packages/:id/specs — ordered membership', () => {
  let early: string;
  let cdSet: string;

  beforeAll(async () => {
    const list = await json('GET', `/projects/${p1}/packages`);
    const pkgs = (await data(list)) as unknown as Array<Record<string, unknown>>;
    early = pkgs.find((p) => p['name'] === 'Early Steel Release')?.['packageId'] as string;
    cdSet = pkgs.find((p) => p['name'] === '100% CD Set')?.['packageId'] as string;
  });

  it('sets ordered membership; a spec may belong to two packages', async () => {
    const res1 = await json('PUT', `/packages/${early}/specs`, { specIds: [steel1] });
    expect(res1.status).toBe(200);
    const res2 = await json('PUT', `/packages/${cdSet}/specs`, { specIds: [hvac1, steel1] });
    expect(res2.status).toBe(200);
    const d2 = await data(res2);
    const specs = d2['specs'] as Array<Record<string, unknown>>;
    expect(specs.map((s) => [s['specId'], s['position']])).toEqual([
      [hvac1, 1],
      [steel1, 2],
    ]);
  });

  it('replacement reorders: PUT again with reversed order', async () => {
    const res = await json('PUT', `/packages/${cdSet}/specs`, { specIds: [steel1, hvac1] });
    const specs = (await data(res))['specs'] as Array<Record<string, unknown>>;
    expect(specs.map((s) => s['specId'])).toEqual([steel1, hvac1]);
  });

  it("422 when a spec belongs to another project's TOC", async () => {
    const res = await json('PUT', `/packages/${early}/specs`, { specIds: [steel1, steel2] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toContain(steel2);
  });

  it('empty array clears the package', async () => {
    const before = await json('PUT', `/packages/${early}/specs`, { specIds: [steel1] });
    expect(before.status).toBe(200);
    const res = await json('PUT', `/packages/${early}/specs`, { specIds: [] });
    expect(res.status).toBe(200);
    expect((await data(res))['specs']).toEqual([]);
  });

  it('404 for unknown package', async () => {
    const res = await json('PUT', `/packages/${ZERO}/specs`, { specIds: [steel1] });
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/:id/packages', () => {
  it('lists packages in position order with ordered membership', async () => {
    const res = await json('GET', `/projects/${p1}/packages`);
    expect(res.status).toBe(200);
    const pkgs = (await data(res)) as unknown as Array<Record<string, unknown>>;
    expect(pkgs.map((p) => p['name'])).toEqual(['Early Steel Release', '100% CD Set']);
    const cd = pkgs[1] as Record<string, unknown>;
    const specs = cd['specs'] as Array<Record<string, unknown>>;
    expect(specs.map((s) => s['specId'])).toEqual([steel1, hvac1]);
    expect(specs[0]?.['section']).toBe('05 12 00');
  });

  it('404 for unknown project', async () => {
    const res = await json('GET', `/projects/${ZERO}/packages`);
    expect(res.status).toBe(404);
  });
});

describe('package_specs RESTRICT interaction (ADR-015 D4)', () => {
  it('DELETE /projects/:id/specs/:specId → 409 while the spec is in a package', async () => {
    const res = await fetch(`${baseUrl}/projects/${p1}/specs/${steel1}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toContain('package');
  });
});

describe('DELETE /packages/:id', () => {
  it('deletes the package and cascades membership; specs survive', async () => {
    const created = await json('POST', `/projects/${p1}/packages`, { name: 'Doomed' });
    const pkgId = (await data(created))['packageId'] as string;
    await json('PUT', `/packages/${pkgId}/specs`, { specIds: [steel1] });
    const res = await fetch(`${baseUrl}/packages/${pkgId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const membership = await pool.query('SELECT 1 FROM package_specs WHERE package_id = $1', [
      pkgId,
    ]);
    expect(membership.rowCount).toBe(0);
    const spec = await pool.query('SELECT 1 FROM specs WHERE id = $1', [steel1]);
    expect(spec.rowCount).toBe(1);
  });

  it('404 for unknown package', async () => {
    const res = await fetch(`${baseUrl}/packages/${ZERO}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration -- src/api/packages.integration.test.ts
```

Expected: FAIL — POST `/projects/:id/packages` returns 404 (route does not exist), assertions on 201 fail.

(Do not commit yet — commit together with the green implementation in Task 4.)

---

### Task 4: Queries + handlers + routes (green)

**Files:**
- Create: `src/db/queries/packages.ts`
- Create: `src/api/packages.ts`
- Modify: `src/db/index.ts` (append barrel exports)
- Modify: `src/api/router.ts`
- Modify: `src/api/projects.ts` (`removeSectionFromProjectHandler`)

- [ ] **Step 1: Implement `src/db/queries/packages.ts`**

```typescript
import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { logger } from '../../lib/logger.js';

/** Design packages (ADR-015 D4, issue #95): named, ordered, issuable subsets
 *  of the project TOC. Membership is restricted to the package's own project
 *  — enforced here at the query layer (see migration 020). */

interface Queryable {
  query: Pool['query'];
}

/** Target package does not exist → 404 at the API layer. */
export class PackageNotFoundError extends DatabaseError {}
/** A spec id is not in the package's project TOC → 422 at the API layer. */
export class SpecNotInProjectError extends DatabaseError {}

export interface PackageSpecEntry {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly position: number;
}

export interface PackageSummary {
  readonly packageId: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
}

export interface PackageWithSpecs extends PackageSummary {
  readonly specs: readonly PackageSpecEntry[];
}

interface PackageRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly position: number;
}

interface PackageListRow extends PackageRow {
  readonly specs: readonly PackageSpecEntry[] | null;
}

interface EntryRow {
  readonly spec_id: string;
  readonly section: string;
  readonly title: string;
  readonly position: number;
}

export async function createPackage(
  projectId: string,
  name: string,
  db: Queryable
): Promise<PackageSummary> {
  try {
    const res = await db.query<PackageRow>(
      `INSERT INTO design_packages (project_id, name, position)
       SELECT $1, $2, COALESCE(MAX(position), 0) + 1
       FROM design_packages WHERE project_id = $1
       RETURNING id, project_id, name, position`,
      [projectId, name]
    );
    const row = res.rows[0];
    if (!row) throw new DatabaseError('createPackage: no row returned after insert');
    return {
      packageId: row.id,
      projectId: row.project_id,
      name: row.name,
      position: row.position,
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`createPackage: insert failed for project ${projectId}`, {
      cause: err,
    });
  }
}

/** Packages in position order, each with its ordered membership. Returns
 *  null when the project does not exist (→ 404 at the API layer). */
export async function listPackages(
  projectId: string,
  db: Queryable
): Promise<readonly PackageWithSpecs[] | null> {
  try {
    const proj = await db.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (proj.rowCount === 0) return null;
    const res = await db.query<PackageListRow>(
      `SELECT dp.id, dp.project_id, dp.name, dp.position,
              COALESCE(
                json_agg(json_build_object(
                  'specId', s.id, 'section', s.section, 'title', s.title,
                  'position', ps.position
                ) ORDER BY ps.position) FILTER (WHERE s.id IS NOT NULL),
                '[]'
              ) AS specs
       FROM design_packages dp
       LEFT JOIN package_specs ps ON ps.package_id = dp.id
       LEFT JOIN specs s ON s.id = ps.spec_id
       WHERE dp.project_id = $1
       GROUP BY dp.id, dp.project_id, dp.name, dp.position
       ORDER BY dp.position, dp.id`,
      [projectId]
    );
    return res.rows.map((row) => ({
      packageId: row.id,
      projectId: row.project_id,
      name: row.name,
      position: row.position,
      specs: row.specs ?? [],
    }));
  } catch (err) {
    throw new DatabaseError(`listPackages: query failed for project ${projectId}`, {
      cause: err,
    });
  }
}

/** SELECT ... FOR UPDATE; resolves the owning project (404 surface if gone). */
async function lockPackage(packageId: string, client: PoolClient): Promise<string> {
  const res = await client.query<{ project_id: string }>(
    'SELECT project_id FROM design_packages WHERE id = $1 FOR UPDATE',
    [packageId]
  );
  const row = res.rows[0];
  if (!row) throw new PackageNotFoundError(`setPackageSpecs: package ${packageId} not found`);
  return row.project_id;
}

/** Membership must be a subset of the package's own project TOC (ADR-015 D4). */
async function assertSpecsInProject(
  projectId: string,
  specIds: readonly string[],
  client: PoolClient
): Promise<void> {
  if (specIds.length === 0) return;
  const res = await client.query<{ spec_id: string }>(
    'SELECT spec_id FROM project_specs WHERE project_id = $1 AND spec_id = ANY($2::uuid[])',
    [projectId, specIds]
  );
  const present = new Set(res.rows.map((row) => row.spec_id));
  const missing = specIds.filter((id) => !present.has(id));
  if (missing.length > 0) {
    // User-facing via the 422 surface — no internal function-name prefix.
    throw new SpecNotInProjectError(
      `specs not in this package's project TOC: ${missing.join(', ')}`
    );
  }
}

/** Full-replacement ordered membership: position = array order (1-based).
 *  Empty array clears the package. One transaction; all-or-nothing. */
export async function setPackageSpecs(
  packageId: string,
  specIds: readonly string[],
  db: Pool = pool
): Promise<readonly PackageSpecEntry[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const projectId = await lockPackage(packageId, client);
    await assertSpecsInProject(projectId, specIds, client);
    await client.query('DELETE FROM package_specs WHERE package_id = $1', [packageId]);
    const res = await client.query<EntryRow>(
      `WITH inserted AS (
         INSERT INTO package_specs (package_id, spec_id, position)
         SELECT $1, u.spec_id, u.ord::int
         FROM unnest($2::uuid[]) WITH ORDINALITY AS u(spec_id, ord)
         RETURNING spec_id, position
       )
       SELECT i.spec_id, s.section, s.title, i.position
       FROM inserted i JOIN specs s ON s.id = i.spec_id
       ORDER BY i.position`,
      [packageId, specIds]
    );
    await client.query('COMMIT');
    logger.info({ packageId, count: specIds.length }, 'setPackageSpecs: membership replaced');
    return res.rows.map((row) => ({
      specId: row.spec_id,
      section: row.section,
      title: row.title,
      position: row.position,
    }));
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`setPackageSpecs: failed for package ${packageId}`, { cause: err });
  } finally {
    client.release();
  }
}

/** Membership rows cascade (migration 020). Returns false when unknown → 404. */
export async function deletePackage(packageId: string, db: Queryable): Promise<boolean> {
  try {
    const res = await db.query('DELETE FROM design_packages WHERE id = $1', [packageId]);
    const deleted = (res.rowCount ?? 0) > 0;
    if (deleted) logger.info({ packageId }, 'deletePackage: package deleted');
    return deleted;
  } catch (err) {
    throw new DatabaseError(`deletePackage: failed for ${packageId}`, { cause: err });
  }
}
```

- [ ] **Step 2: Append barrel exports to `src/db/index.ts`**

```typescript
export {
  createPackage,
  listPackages,
  setPackageSpecs,
  deletePackage,
  PackageNotFoundError,
  SpecNotInProjectError,
} from './queries/packages.js';
export type { PackageSummary, PackageWithSpecs, PackageSpecEntry } from './queries/packages.js';
```

- [ ] **Step 3: Implement `src/api/packages.ts`**

```typescript
import type { Request, Response } from 'express';
import {
  createPackage,
  listPackages,
  setPackageSpecs,
  deletePackage,
  PackageNotFoundError,
  SpecNotInProjectError,
  pool,
} from '../db/index.js';
import type { CreatePackageBody, SetPackageSpecsBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

export async function createPackageHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const body = req.body as CreatePackageBody;
    const pkg = await createPackage(id, body.name, pool);
    res.status(201).json({ success: true, data: pkg });
  } catch (err) {
    const mapped = pgErrorToHttp(err, {
      '23503': 'project not found',
      '23505': 'package name already exists in this project',
    });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'create package failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function listPackagesHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const packages = await listPackages(id, pool);
    if (packages === null) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    res.status(200).json({ success: true, data: packages });
  } catch (err) {
    logger.error({ err }, 'list packages failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function setPackageSpecsHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing package id' });
    return;
  }
  try {
    const body = req.body as SetPackageSpecsBody;
    const specs = await setPackageSpecs(id, body.specIds, pool);
    res.status(200).json({ success: true, data: { packageId: id, specs } });
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    if (err instanceof SpecNotInProjectError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'set package specs failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function deletePackageHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing package id' });
    return;
  }
  try {
    const deleted = await deletePackage(id, pool);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'package not found' });
      return;
    }
    res.status(200).json({ success: true, data: { packageId: id } });
  } catch (err) {
    logger.error({ err }, 'delete package failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

- [ ] **Step 4: Wire routes in `src/api/router.ts`** — import the handlers and schemas, add after the existing `/projects` routes:

```typescript
import {
  createPackageHandler,
  listPackagesHandler,
  setPackageSpecsHandler,
  deletePackageHandler,
} from './packages.js';
// add CreatePackageBodySchema, SetPackageSpecsBodySchema to the '../ast/index.js' import

router.post(
  '/projects/:id/packages',
  validateBody(CreatePackageBodySchema),
  createPackageHandler
);
router.get('/projects/:id/packages', listPackagesHandler);
router.put('/packages/:id/specs', validateBody(SetPackageSpecsBodySchema), setPackageSpecsHandler);
router.delete('/packages/:id', deletePackageHandler);
```

- [ ] **Step 5: Map the new RESTRICT FK in `removeSectionFromProjectHandler`** (`src/api/projects.ts`) — without this, deleting a spec that is in a package surfaces as 500. Add `getPgCode` to the `'../lib/pg-errors.js'` import and insert at the top of that handler's `catch` block:

```typescript
    // package_specs.spec_id is ON DELETE RESTRICT (migration 020): the spec
    // must leave its design packages before it can leave the project.
    if (getPgCode(err) === '23503') {
      res.status(409).json({
        success: false,
        error: 'section belongs to a design package — remove it from the package first',
      });
      return;
    }
```

- [ ] **Step 6: Run integration tests to verify pass**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration -- src/api/packages.integration.test.ts
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration -- src/api/projects.integration.test.ts
```

Expected: both PASS (the second proves no regression on the modified handler).

- [ ] **Step 7: Lint + unit tests**

```bash
pnpm lint && pnpm test
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/db/queries/packages.ts src/db/index.ts src/api/packages.ts src/api/router.ts src/api/projects.ts src/api/packages.integration.test.ts
git commit -m "feat(db): design packages — ordered TOC subsets + REST endpoints (ADR-015 D4)

POST/GET /projects/:id/packages, PUT /packages/:id/specs (full-replacement
ordered membership, same-project enforced at the query layer), DELETE
/packages/:id. removeSectionFromProject now maps the package_specs RESTRICT
FK to 409 instead of 500.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: OpenAPI + final verification

**Files:**
- Modify: `openapi.yaml`

- [ ] **Step 1: Add paths** (after `/projects/{id}/references/broken`, mirroring existing style): `POST`+`GET /projects/{id}/packages`, `PUT /packages/{id}/specs`, `DELETE /packages/{id}`. Add `packages` tag. Request bodies mirror the Zod schemas (name minLength 1; specIds uuid array, uniqueItems). Responses: 201/409/404/422 for create; 200/404 for list; 200/404/422 for PUT; 200/404 for DELETE. Add component schemas `PackageSummary` (packageId, projectId, name, position), `PackageSpecEntry` (specId, section, title, position), `PackageWithSpecs` (allOf PackageSummary + specs array). Update the `DELETE /projects/{id}/specs/{specId}` 409 description to: `'Section has project edits (repeat with ?force=true) or belongs to a design package'`.

- [ ] **Step 2: Format + full verification**

```bash
pnpm format
pnpm lint && pnpm build && pnpm test
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add openapi.yaml docs/superpowers/plans/2026-06-12-issue-95-design-packages.md
git commit -m "docs(api): OpenAPI spec for design package endpoints (issue #95)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Clean up the test database container**

```bash
docker stop specr-pg-95
```
