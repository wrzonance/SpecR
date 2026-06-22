# Required Sections Substrate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a first-class `required_sections` table + authoring API so a project (and each design package) can declare the CSI section *numbers* it must contain — including sections not yet derived as documents.

**Architecture:** One new table (`required_sections`, migration 031), one DB query module (`src/db/queries/required-sections.ts`) with list/replace/seed, four Express handlers (`src/api/required-sections.ts`) over two scopes (project baseline + package), all documented in `openapi.yaml`. Closely mirrors the existing `division-general` (scoped authored table) and `setProjectSources` (transactional full-replace) patterns. Substrate only — the coordination report (#105) and Revit writer (#84) are downstream.

**Tech Stack:** TypeScript/Node 22 (ESM, `.js` relative imports), Express, Zod v4, node-pg-migrate (`--tsx`), PostgreSQL, Vitest (integration against real Postgres), hand-authored `openapi.yaml` (CI contract gate).

## Global Constraints

- **GATE — execution blocked until ADR-028 (PR #238) merges.** This is a Track B design gate: no endpoint code lands before the ADR is on `main`. Decision-of-record: `docs/adr/028-required-sections.md`. Spec: `docs/superpowers/specs/2026-06-22-required-sections-design.md`.
- **Branch `feat/api-required-sections` off `origin/main`; never commit to main.** Conventional Commits scoped per module (`feat(db): …`, `feat(api): …`). Credit the agent: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (or the agent that does the work).
- **`openapi.yaml` is authoritative and CI-enforced (ADR-026).** Every new route is documented in the SAME task; the contract gate (`src/api/contract.integration.test.ts`) checks route↔spec bidirectional coverage + response-schema validation.
- **ESLint enforced:** `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, `no-console` error, `no-explicit-any` error, no non-null `!` outside tests. Modules import only via sibling `index.ts` barrels (`../db/index.js`).
- **Parameterized SQL only** (no string-built values); the only interpolation permitted is a fixed column/table name from a closed set, as in `division-general.ts`.
- **Typed errors with `cause` chains** extending `DatabaseError` (`src/db/errors.ts`); the API maps them. Validate external input with Zod at the boundary.
- **Section numbers:** input is validated/normalized with `SectionNumberInputSchema` (`src/lib/section-number.ts`) → canonical; the DB CHECK uses the migration-013 shape `^\d{2} \d{2} \d{2}(\.\d{2}( \d{2})?)?$` as defense-in-depth.
- **PR ≤ ~250 LOC** of real change (excl. `openapi.yaml`). Run `pnpm migrate && pnpm seed` before integration tests; `DATABASE_URL` from `.env`.

---

## File Structure

- **Create** `src/db/migrations/031_create_required_sections.ts` — the table (Task 1).
- **Create** `src/db/queries/required-sections.ts` — types, typed errors, `listRequiredSections`, `setRequiredSections`, `seedRequiredSections`, and self-contained `projectExists`/`packageInProjectExists` helpers (Task 2).
- **Modify** `src/db/index.ts` — barrel-export the new query fns + types (Task 2).
- **Create** `src/db/queries/required-sections.integration.test.ts` — DB-layer tests (Task 2).
- **Create** `src/api/required-sections.ts` — four handlers (Task 3).
- **Modify** `src/api/router.ts` — register four routes + `validateBody` (Task 3).
- **Modify** `src/ast/schemas.ts` + `src/ast/index.ts` — `RequiredSectionsBodySchema` + barrel (Task 3).
- **Create** `src/api/required-sections.integration.test.ts` — API tests (Task 3).
- **Modify** `openapi.yaml` — four paths + `RequiredSection` schema (Task 4).

**Scope resolution (used throughout):** a request targets either the **baseline** (`package_id IS NULL`) or a **package** (`package_id = X`). `seedFrom` is honored only when the target scope is currently empty: baseline accepts `'toc'`; a package accepts `'baseline' | 'toc' | { packageId }`. `sections` and `seedFrom` are mutually exclusive.

---

## Task 1: Migration 031 — `required_sections` table

**Files:**
- Create: `src/db/migrations/031_create_required_sections.ts`

**Interfaces:**
- Produces: table `required_sections(id, project_id, package_id, section, title, position)` with two partial-unique indexes and a section-shape CHECK. Consumed by Task 2.

- [ ] **Step 1: Write the migration**

```typescript
// src/db/migrations/031_create_required_sections.ts
import type { MigrationBuilder } from 'node-pg-migrate';

// Authored coordination intent (ADR-028). Unlike project_specs/package_specs,
// this names sections by NUMBER and may include sections with no derived spec
// document yet. Expanded CSI shape (ADR-020), mirroring migration 013's gate.
const SECTION_SHAPE = String.raw`^\d{2} \d{2} \d{2}(\.\d{2}( \d{2})?)?$`;

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('required_sections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' },
    package_id: { type: 'uuid', references: 'design_packages', onDelete: 'CASCADE' },
    section: { type: 'text', notNull: true },
    title: { type: 'text' },
    position: { type: 'integer', notNull: true },
  });

  pgm.addConstraint('required_sections', 'required_sections_position_check', {
    check: 'position >= 1',
  });
  pgm.addConstraint('required_sections', 'required_sections_section_shape_check', {
    check: `section ~ '${SECTION_SHAPE}'`,
  });

  pgm.createIndex('required_sections', ['project_id', 'section'], {
    name: 'required_sections_project_section_unique',
    unique: true,
    where: 'package_id IS NULL',
  });
  pgm.createIndex('required_sections', ['project_id', 'package_id', 'section'], {
    name: 'required_sections_project_package_section_unique',
    unique: true,
    where: 'package_id IS NOT NULL',
  });
  pgm.createIndex('required_sections', ['project_id', 'package_id'], {
    name: 'required_sections_scope_idx',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('required_sections', { cascade: true });
};
```

- [ ] **Step 2: Apply the migration**

Run: `pnpm migrate`
Expected: `### MIGRATION 031_create_required_sections (UP) ###` then success.

- [ ] **Step 3: Verify the table + constraints exist**

Run: `psql "$DATABASE_URL" -c "\d required_sections"`
Expected: columns `id, project_id, package_id, section, title, position`; the two partial-unique indexes and both check constraints listed.

- [ ] **Step 4: Verify reversibility (down → up)**

Run: `pnpm migrate:down && psql "$DATABASE_URL" -tAc "select to_regclass('public.required_sections')" && pnpm migrate`
Expected: after `migrate:down` the `to_regclass` prints an empty line (table gone); `pnpm migrate` re-creates it cleanly. (Migrations are the schema of record, not vitest targets — CLAUDE.md.)

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/031_create_required_sections.ts
git commit -m "feat(db): required_sections table (migration 031, ADR-028) (#237)"
```

---

## Task 2: DB query module — list / replace / seed

**Files:**
- Create: `src/db/queries/required-sections.ts`
- Modify: `src/db/index.ts`
- Test: `src/db/queries/required-sections.integration.test.ts`

**Interfaces:**
- Consumes: `pool` and `DatabaseError` from the db module; table from Task 1.
- Produces (imported by Task 3):
  - `RequiredSection = { id: string; section: string; title: string | null; position: number }`
  - `RequiredSectionInput = { section: string; title?: string }`
  - `RequiredScope = { kind: 'baseline'; projectId: string } | { kind: 'package'; projectId: string; packageId: string }`
  - `SeedSource = { from: 'baseline' } | { from: 'toc' } | { from: 'package'; packageId: string }`
  - `listRequiredSections(scope, db?): Promise<RequiredSection[]>`
  - `setRequiredSections(scope, entries: readonly RequiredSectionInput[], db?): Promise<RequiredSection[]>`
  - `seedRequiredSections(scope, seed: SeedSource, db?): Promise<RequiredSection[]>`
  - Errors: `RequiredSectionsProjectNotFoundError`, `RequiredSectionsPackageNotFoundError`, `RequiredSectionsSeedConflictError`, `RequiredSectionsInvalidSeedError` (all extend `DatabaseError`).

- [ ] **Step 1: Write the failing DB-layer test**

```typescript
// src/db/queries/required-sections.integration.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  listRequiredSections,
  setRequiredSections,
  seedRequiredSections,
  RequiredSectionsSeedConflictError,
  type RequiredScope,
} from './required-sections.js';

async function newProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [name]);
  return r.rows[0]!.id;
}
async function newPackage(projectId: string, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, name]
  );
  return r.rows[0]!.id;
}

let projectId: string;
const baseline = (): RequiredScope => ({ kind: 'baseline', projectId });

beforeAll(async () => { projectId = await newProject('req-sections-it'); });
afterEach(async () => { await pool.query(`DELETE FROM required_sections WHERE project_id = $1`, [projectId]); });

describe('required_sections query layer', () => {
  it('replaces a scope and returns rows ordered by position', async () => {
    const rows = await setRequiredSections(baseline(), [
      { section: '03 30 00', title: 'Cast-in-Place Concrete' },
      { section: '09 91 00' },
    ]);
    expect(rows.map((r) => [r.section, r.position, r.title])).toEqual([
      ['03 30 00', 1, 'Cast-in-Place Concrete'],
      ['09 91 00', 2, null],
    ]);
    const read = await listRequiredSections(baseline());
    expect(read).toEqual(rows);
  });

  it('renumbers position on replace and isolates package scope from baseline', async () => {
    const packageId = await newPackage(projectId, 'Steel ER');
    await setRequiredSections(baseline(), [{ section: '03 30 00' }]);
    await setRequiredSections({ kind: 'package', projectId, packageId }, [{ section: '05 12 00' }]);
    expect((await listRequiredSections(baseline())).map((r) => r.section)).toEqual(['03 30 00']);
    expect((await listRequiredSections({ kind: 'package', projectId, packageId })).map((r) => r.section)).toEqual(['05 12 00']);
  });

  // KNOWN INVARIANT (ADR-015 D2): a package seeded from the baseline is a snapshot —
  // later baseline edits MUST NOT propagate into the package.
  it('seed: package copies the baseline as an independent snapshot', async () => {
    const packageId = await newPackage(projectId, 'CD set');
    const pkg: RequiredScope = { kind: 'package', projectId, packageId };
    await setRequiredSections(baseline(), [{ section: '03 30 00' }, { section: '09 91 00' }]);
    const seeded = await seedRequiredSections(pkg, { from: 'baseline' });
    expect(seeded.map((r) => r.section)).toEqual(['03 30 00', '09 91 00']);
    await setRequiredSections(baseline(), [{ section: '07 92 00' }]); // mutate baseline after seed
    expect((await listRequiredSections(pkg)).map((r) => r.section)).toEqual(['03 30 00', '09 91 00']);
  });

  it('seed: rejects a non-empty target scope with RequiredSectionsSeedConflictError', async () => {
    const packageId = await newPackage(projectId, 'dup');
    const pkg: RequiredScope = { kind: 'package', projectId, packageId };
    await setRequiredSections(pkg, [{ section: '05 12 00' }]);
    await expect(seedRequiredSections(pkg, { from: 'baseline' })).rejects.toBeInstanceOf(RequiredSectionsSeedConflictError);
  });

  it('rejects a duplicate section within a scope (partial unique index → 23505)', async () => {
    await expect(
      pool.query(
        `INSERT INTO required_sections (project_id, package_id, section, position)
         VALUES ($1, NULL, '03 30 00', 1), ($1, NULL, '03 30 00', 2)`,
        [projectId]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm test:integration -- required-sections`
Expected: FAIL — `Cannot find module './required-sections.js'` / exports undefined.

- [ ] **Step 3: Implement the query module**

```typescript
// src/db/queries/required-sections.ts
import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';

interface Queryable {
  query: Pool['query'];
}

export interface RequiredSection {
  readonly id: string;
  readonly section: string;
  readonly title: string | null;
  readonly position: number;
}

export interface RequiredSectionInput {
  readonly section: string; // canonical — validated at the API boundary
  readonly title?: string;
}

export type RequiredScope =
  | { readonly kind: 'baseline'; readonly projectId: string }
  | { readonly kind: 'package'; readonly projectId: string; readonly packageId: string };

export type SeedSource =
  | { readonly from: 'baseline' }
  | { readonly from: 'toc' }
  | { readonly from: 'package'; readonly packageId: string };

export class RequiredSectionsProjectNotFoundError extends DatabaseError {}
export class RequiredSectionsPackageNotFoundError extends DatabaseError {}
export class RequiredSectionsSeedConflictError extends DatabaseError {}
export class RequiredSectionsInvalidSeedError extends DatabaseError {}

interface Row {
  readonly id: string;
  readonly section: string;
  readonly title: string | null;
  readonly position: number;
}

const SELECT_COLS = 'id, section, title, position';

function packageId(scope: RequiredScope): string | null {
  return scope.kind === 'package' ? scope.packageId : null;
}

async function assertScopeExists(scope: RequiredScope, db: Queryable): Promise<void> {
  const proj = await db.query(`SELECT 1 FROM projects WHERE id = $1`, [scope.projectId]);
  if ((proj.rowCount ?? 0) === 0) {
    throw new RequiredSectionsProjectNotFoundError(`project ${scope.projectId} not found`);
  }
  if (scope.kind === 'package') {
    const pkg = await db.query(`SELECT 1 FROM design_packages WHERE id = $1 AND project_id = $2`, [
      scope.packageId,
      scope.projectId,
    ]);
    if ((pkg.rowCount ?? 0) === 0) {
      throw new RequiredSectionsPackageNotFoundError(
        `package ${scope.packageId} not found in project ${scope.projectId}`
      );
    }
  }
}

async function readScope(scope: RequiredScope, db: Queryable): Promise<readonly RequiredSection[]> {
  const result = await db.query<Row>(
    `SELECT ${SELECT_COLS} FROM required_sections
     WHERE project_id = $1 AND package_id IS NOT DISTINCT FROM $2
     ORDER BY position`,
    [scope.projectId, packageId(scope)]
  );
  return result.rows;
}

export async function listRequiredSections(
  scope: RequiredScope,
  db: Queryable = pool
): Promise<readonly RequiredSection[]> {
  try {
    await assertScopeExists(scope, db);
    return await readScope(scope, db);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`listRequiredSections failed for project ${scope.projectId}`, { cause: err });
  }
}

export async function setRequiredSections(
  scope: RequiredScope,
  entries: readonly RequiredSectionInput[],
  db: Pool = pool
): Promise<readonly RequiredSection[]> {
  let client: PoolClient | null = null;
  try {
    await assertScopeExists(scope, db);
    client = await db.connect();
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM required_sections WHERE project_id = $1 AND package_id IS NOT DISTINCT FROM $2`,
      [scope.projectId, packageId(scope)]
    );
    await client.query(
      `INSERT INTO required_sections (project_id, package_id, section, title, position)
       SELECT $1, $2, e.section, e.title, e.ord::int
       FROM jsonb_to_recordset($3::jsonb) AS e(section text, title text, ord int)`,
      [
        scope.projectId,
        packageId(scope),
        JSON.stringify(entries.map((e, i) => ({ section: e.section, title: e.title ?? null, ord: i + 1 }))),
      ]
    );
    await client.query('COMMIT');
    return await readScope(scope, db);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`setRequiredSections failed for project ${scope.projectId}`, { cause: err });
  } finally {
    if (client) client.release();
  }
}

function validateSeedForScope(scope: RequiredScope, seed: SeedSource): void {
  if (scope.kind === 'baseline' && seed.from !== 'toc') {
    throw new RequiredSectionsInvalidSeedError(`baseline can only be seeded from 'toc', not '${seed.from}'`);
  }
}

async function seedRows(
  scope: RequiredScope,
  seed: SeedSource,
  client: PoolClient
): Promise<void> {
  const target = [scope.projectId, packageId(scope)];
  if (seed.from === 'toc') {
    await client.query(
      `INSERT INTO required_sections (project_id, package_id, section, title, position)
       SELECT $1, $2, s.section, s.title, ps.position
       FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
       WHERE ps.project_id = $1 AND s.section ~ '^\\d{2} \\d{2} \\d{2}(\\.\\d{2}( \\d{2})?)?$'
       ORDER BY ps.position`,
      target
    );
    return;
  }
  const sourcePackage = seed.from === 'baseline' ? null : seed.packageId;
  await client.query(
    `INSERT INTO required_sections (project_id, package_id, section, title, position)
     SELECT $1, $2, r.section, r.title, r.position
     FROM required_sections r
     WHERE r.project_id = $1 AND r.package_id IS NOT DISTINCT FROM $3
     ORDER BY r.position`,
    [scope.projectId, packageId(scope), sourcePackage]
  );
}

export async function seedRequiredSections(
  scope: RequiredScope,
  seed: SeedSource,
  db: Pool = pool
): Promise<readonly RequiredSection[]> {
  let client: PoolClient | null = null;
  try {
    validateSeedForScope(scope, seed);
    await assertScopeExists(scope, db);
    client = await db.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT 1 FROM required_sections WHERE project_id = $1 AND package_id IS NOT DISTINCT FROM $2 LIMIT 1`,
      [scope.projectId, packageId(scope)]
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw new RequiredSectionsSeedConflictError(`target scope already has required sections; replace explicitly`);
    }
    await seedRows(scope, seed, client);
    await client.query('COMMIT');
    return await readScope(scope, db);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`seedRequiredSections failed for project ${scope.projectId}`, { cause: err });
  } finally {
    if (client) client.release();
  }
}
```

> Note: `package_id IS NOT DISTINCT FROM $2` makes a single query handle both baseline (`$2 = NULL`) and package (`$2 = uuid`) scopes — NULL-safe equality. The `setRequiredSections`/`seedRequiredSections` `db` param is typed `Pool` (not `Queryable`) because they call `.connect()` for the transaction, exactly as `setProjectSources` does.

- [ ] **Step 4: Barrel-export from `src/db/index.ts`**

Add alongside the other `./queries/*.js` re-exports:

```typescript
export {
  listRequiredSections,
  setRequiredSections,
  seedRequiredSections,
  RequiredSectionsProjectNotFoundError,
  RequiredSectionsPackageNotFoundError,
  RequiredSectionsSeedConflictError,
  RequiredSectionsInvalidSeedError,
} from './queries/required-sections.js';
export type {
  RequiredSection,
  RequiredSectionInput,
  RequiredScope,
  SeedSource,
} from './queries/required-sections.js';
```

- [ ] **Step 5: Run tests; verify they pass**

Run: `pnpm test:integration -- required-sections`
Expected: PASS (all cases, including the D2 snapshot invariant and the 23505 dup).

- [ ] **Step 6: Lint**

Run: `pnpm lint`
Expected: clean (watch `max-lines-per-function` ≤ 50 — the helpers above are each well under).

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/required-sections.ts src/db/queries/required-sections.integration.test.ts src/db/index.ts
git commit -m "feat(db): required-sections query layer — list/replace/seed (#237)"
```

---

## Task 3: API layer — handlers, body schema, routes

**Files:**
- Create: `src/api/required-sections.ts`
- Modify: `src/ast/schemas.ts`, `src/ast/index.ts`, `src/api/router.ts`
- Test: `src/api/required-sections.integration.test.ts`

**Interfaces:**
- Consumes: the Task 2 exports from `../db/index.js`; `pgErrorToHttp` from `../lib/pg-errors.js`; `SectionNumberInputSchema` from `../lib/section-number.js`; `validateBody` from `./middleware/validate.js`.
- Produces: `listBaselineRequiredSectionsHandler`, `putBaselineRequiredSectionsHandler`, `listPackageRequiredSectionsHandler`, `putPackageRequiredSectionsHandler`; `RequiredSectionsBodySchema` (in `src/ast/schemas.ts`).

**Body contract:** `{ sections?: [{ section, title? }], seedFrom? }` — `sections` and `seedFrom` are mutually exclusive (the schema rejects both → 422). `seedFrom` ∈ `'baseline' | 'toc' | { packageId }`. The handler validates the path id(s) with `z.uuid()` (→ 400) and branches: `sections` present → replace; `seedFrom` present → seed; neither → replace with `[]` (clear the scope).

- [ ] **Step 1: Add the body schema to `src/ast/schemas.ts`**

```typescript
import { SectionNumberInputSchema } from '../lib/section-number.js'; // add to existing imports

const RequiredSectionEntrySchema = z.object({
  section: SectionNumberInputSchema,
  title: z.string().check(z.minLength(1)).exactOptional(),
});

const SeedFromSchema = z.union([
  z.literal('baseline'),
  z.literal('toc'),
  z.object({ packageId: z.uuid() }),
]);

export const RequiredSectionsBodySchema = z
  .object({
    sections: z.array(RequiredSectionEntrySchema).exactOptional(),
    seedFrom: SeedFromSchema.exactOptional(),
  })
  .check((ctx) => {
    if (ctx.value.sections !== undefined && ctx.value.seedFrom !== undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'provide either sections or seedFrom, not both',
      });
    }
    const sections = ctx.value.sections;
    if (sections && new Set(sections.map((s) => s.section)).size !== sections.length) {
      ctx.issues.push({ code: 'custom', input: ctx.value, message: 'sections must not contain duplicates' });
    }
  });

export type RequiredSectionsBody = z.infer<typeof RequiredSectionsBodySchema>;
```

Then export both from `src/ast/index.ts` (mirror the existing `CreateProjectBodySchema` / `CreateProjectBody` export lines).

- [ ] **Step 2: Write the failing API test**

```typescript
// src/api/required-sections.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let projectId: string;
let packageId: string;

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 3000}`;
  const p = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('req-api-it') RETURNING id`);
  projectId = p.rows[0]!.id;
  const pkg = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, 'pkg', 1) RETURNING id`, [projectId]
  );
  packageId = pkg.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]); // cascades required_sections + packages
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('required-sections API', () => {
  it('PUT replaces the baseline and GET returns it', async () => {
    const put = await req('PUT', `/projects/${projectId}/required-sections`, {
      sections: [{ section: '03 30 00', title: 'Concrete' }, { section: '09 91 00' }],
    });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
    expect(put.body.data.map((r: any) => [r.section, r.position])).toEqual([['03 30 00', 1], ['09 91 00', 2]]);
    const get = await req('GET', `/projects/${projectId}/required-sections`);
    expect(get.status).toBe(200);
    expect(get.body.data).toHaveLength(2);
  });

  it('PUT package with seedFrom=baseline copies the baseline', async () => {
    const seeded = await req('PUT', `/projects/${projectId}/packages/${packageId}/required-sections`, { seedFrom: 'baseline' });
    expect(seeded.status).toBe(200);
    expect(seeded.body.data.map((r: any) => r.section)).toEqual(['03 30 00', '09 91 00']);
  });

  it('rejects sections + seedFrom together with 422', async () => {
    const res = await req('PUT', `/projects/${projectId}/required-sections`, { sections: [{ section: '03 30 00' }], seedFrom: 'toc' });
    expect(res.status).toBe(422);
  });

  it('422 on a malformed section', async () => {
    const res = await req('PUT', `/projects/${projectId}/required-sections`, { sections: [{ section: 'nope' }] });
    expect(res.status).toBe(422);
  });

  it('400 on a malformed project id, 404 on unknown project', async () => {
    expect((await req('GET', `/projects/not-a-uuid/required-sections`)).status).toBe(400);
    expect((await req('GET', `/projects/11111111-1111-4111-8111-111111111111/required-sections`)).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run it; verify it fails**

Run: `pnpm test:integration -- required-sections.integration` (API file)
Expected: FAIL — routes 404 (not registered).

- [ ] **Step 4: Implement the handlers**

```typescript
// src/api/required-sections.ts
import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  listRequiredSections,
  setRequiredSections,
  seedRequiredSections,
  RequiredSectionsProjectNotFoundError,
  RequiredSectionsPackageNotFoundError,
  RequiredSectionsSeedConflictError,
  RequiredSectionsInvalidSeedError,
  pool,
  type RequiredScope,
  type SeedSource,
} from '../db/index.js';
import type { RequiredSectionsBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';

function seedSourceFrom(seedFrom: NonNullable<RequiredSectionsBody['seedFrom']>): SeedSource {
  if (seedFrom === 'baseline') return { from: 'baseline' };
  if (seedFrom === 'toc') return { from: 'toc' };
  return { from: 'package', packageId: seedFrom.packageId };
}

async function applyBody(scope: RequiredScope, body: RequiredSectionsBody) {
  if (body.seedFrom !== undefined) return seedRequiredSections(scope, seedSourceFrom(body.seedFrom), pool);
  return setRequiredSections(scope, body.sections ?? [], pool);
}

function mapError(err: unknown, res: Response, where: string): void {
  if (err instanceof RequiredSectionsProjectNotFoundError || err instanceof RequiredSectionsPackageNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof RequiredSectionsSeedConflictError) {
    res.status(409).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof RequiredSectionsInvalidSeedError) {
    res.status(422).json({ success: false, error: err.message });
    return;
  }
  const mapped = pgErrorToHttp(err);
  if (mapped) {
    res.status(mapped.status).json({ success: false, error: mapped.error });
    return;
  }
  logger.error({ err }, `${where} failed`);
  res.status(500).json({ success: false, error: 'internal server error' });
}

function parseProjectId(req: Request, res: Response): string | null {
  const parsed = z.uuid().safeParse(req.params['id']);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return null;
  }
  return parsed.data;
}

function parsePackageId(req: Request, res: Response): string | null {
  const parsed = z.uuid().safeParse(req.params['packageId']);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'invalid package id' });
    return null;
  }
  return parsed.data;
}

export async function listBaselineRequiredSectionsHandler(req: Request, res: Response): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  try {
    const data = await listRequiredSections({ kind: 'baseline', projectId });
    res.status(200).json({ success: true, data });
  } catch (err) {
    mapError(err, res, 'list baseline required-sections');
  }
}

export async function putBaselineRequiredSectionsHandler(req: Request, res: Response): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  try {
    const data = await applyBody({ kind: 'baseline', projectId }, req.body as RequiredSectionsBody);
    res.status(200).json({ success: true, data });
  } catch (err) {
    mapError(err, res, 'put baseline required-sections');
  }
}

export async function listPackageRequiredSectionsHandler(req: Request, res: Response): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  const packageId = parsePackageId(req, res);
  if (!packageId) return;
  try {
    const data = await listRequiredSections({ kind: 'package', projectId, packageId });
    res.status(200).json({ success: true, data });
  } catch (err) {
    mapError(err, res, 'list package required-sections');
  }
}

export async function putPackageRequiredSectionsHandler(req: Request, res: Response): Promise<void> {
  const projectId = parseProjectId(req, res);
  if (!projectId) return;
  const packageId = parsePackageId(req, res);
  if (!packageId) return;
  try {
    const data = await applyBody({ kind: 'package', projectId, packageId }, req.body as RequiredSectionsBody);
    res.status(200).json({ success: true, data });
  } catch (err) {
    mapError(err, res, 'put package required-sections');
  }
}
```

- [ ] **Step 5: Register routes in `src/api/router.ts`**

Add the import alongside the other handler imports:

```typescript
import {
  listBaselineRequiredSectionsHandler,
  putBaselineRequiredSectionsHandler,
  listPackageRequiredSectionsHandler,
  putPackageRequiredSectionsHandler,
} from './required-sections.js';
```

Add `RequiredSectionsBodySchema` to the `../ast/index.js` schema import block, then register the routes near the other `/projects/:id/...` routes:

```typescript
router.get('/projects/:id/required-sections', listBaselineRequiredSectionsHandler);
router.put('/projects/:id/required-sections', validateBody(RequiredSectionsBodySchema), putBaselineRequiredSectionsHandler);
router.get('/projects/:id/packages/:packageId/required-sections', listPackageRequiredSectionsHandler);
router.put('/projects/:id/packages/:packageId/required-sections', validateBody(RequiredSectionsBodySchema), putPackageRequiredSectionsHandler);
```

- [ ] **Step 6: Run tests; verify they pass**

Run: `pnpm test:integration -- required-sections`
Expected: PASS (both DB and API files).

- [ ] **Step 7: Commit**

```bash
git add src/api/required-sections.ts src/api/required-sections.integration.test.ts src/api/router.ts src/ast/schemas.ts src/ast/index.ts
git commit -m "feat(api): required-sections endpoints — baseline + package, seed-on-empty (#237)"
```

---

## Task 4: OpenAPI documentation + contract gate

**Files:**
- Modify: `openapi.yaml`

**Interfaces:**
- Consumes: the four routes from Task 3.
- Produces: documented paths + a `RequiredSection` response schema; the contract gate stays green.

- [ ] **Step 1: Run the contract gate to see it fail**

Run: `pnpm test:integration -- contract`
Expected: FAIL — the four new routes are reported as undocumented (route↔spec coverage gap).

- [ ] **Step 2: Add a reusable response schema under `components.schemas`**

```yaml
    RequiredSection:
      type: object
      required: [id, section, title, position]
      properties:
        id: { type: string, format: uuid }
        section:
          type: string
          description: Canonical CSI section number (ADR-020 expanded shape).
        title: { type: string, nullable: true }
        position: { type: integer, minimum: 1 }
```

- [ ] **Step 3: Document the baseline paths** (mirror the inline style of `/projects/{id}/sources`)

```yaml
  /projects/{id}/required-sections:
    get:
      operationId: listBaselineRequiredSections
      summary: List a project's baseline required sections
      tags: [projects]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: Baseline required-section list
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        type: array
                        items: { $ref: '#/components/schemas/RequiredSection' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { $ref: '#/components/responses/NotFound' }
    put:
      operationId: putBaselineRequiredSections
      summary: Replace (or seed) a project's baseline required sections
      description: >
        `sections` and `seedFrom` are mutually exclusive. `seedFrom: toc` copies
        the project's TOC into an empty baseline. Re-replacing renumbers position.
      tags: [projects]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/RequiredSectionsBody' }
      responses:
        '200':
          description: Updated baseline required-section list
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        type: array
                        items: { $ref: '#/components/schemas/RequiredSection' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { $ref: '#/components/responses/NotFound' }
        '409': { $ref: '#/components/responses/Conflict' }
        '422': { $ref: '#/components/responses/ValidationError' }
```

> Confirm the exact names of the shared `responses` ($ref `BadRequest`/`NotFound`/`Conflict`/`ValidationError`) and `SuccessResponse` against the top of `openapi.yaml` before writing — reuse whatever the file already defines; if a status helper is absent, inline the response object as `/projects/{id}/sources` does. Add a `RequiredSectionsBody` request schema under `components.schemas` matching the Zod shape from Task 3 (`sections` array of `{section, title?}`, `seedFrom` oneOf `baseline`/`toc`/`{packageId}`).

- [ ] **Step 4: Document the two package paths**

Same two operations under `/projects/{id}/packages/{packageId}/required-sections`, adding the `packageId` path parameter and operationIds `listPackageRequiredSections` / `putPackageRequiredSections`. The `put` lists the same `400/404/409/422` responses (a package `seedFrom` may be `baseline`/`toc`/`{packageId}`).

- [ ] **Step 5: Run the contract gate + full lint/test**

Run: `pnpm test:integration -- contract && pnpm lint && pnpm test:integration -- required-sections`
Expected: all PASS — route↔spec bidirectional coverage satisfied, response schemas validate.

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml
git commit -m "docs(openapi): document required-sections endpoints (#237)"
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin feat/api-required-sections
gh pr create --base main --title "feat(api): required-sections substrate (ADR-028)" \
  --body "Implements the ADR-028 substrate. Closes #237. See docs/superpowers/plans/2026-06-22-required-sections.md."
```

Drive CI + CodeRabbit green (use the review-remote-pr loop), then leave open for the maintainer to merge.

---

## Self-Review

- **Spec coverage:** §2 data model → Task 1. §3 query layer (list/set/seed + scope helpers) → Task 2. §4 API table + OpenAPI → Tasks 3–4. §6 test plan: scope isolation, partial-unique dup, CHECK, position renumber, seed-copy independence (D2), `sections`+`seedFrom`→422, status/envelope per endpoint, 400/404/422/409 → covered across Task 2/3 tests + contract gate. §9 open items resolved: (1) CHECK shape = migration-013 regex; (2) package existence is a self-contained `SELECT 1 FROM design_packages WHERE id=$1 AND project_id=$2` (no new `packages.ts` export); (3) dual-mode = one `RequiredSectionsBodySchema` with a `.check` refine rejecting both, validated via `validateBody` (422), id via in-handler `z.uuid()` (400).
- **Placeholder scan:** none — every step carries real code/commands. The two "confirm against the file" notes (shared `responses` names; `ast/index.ts` export lines) are verification cues for facts that live outside the files read while planning, not deferred work.
- **Type consistency:** `RequiredSection`, `RequiredSectionInput`, `RequiredScope`, `SeedSource`, `RequiredSectionsBody`, and the four handler names are identical across Tasks 2–4. `setRequiredSections`/`seedRequiredSections` take `db: Pool` (they `.connect()`); `listRequiredSections` takes `db: Queryable` — matching `setProjectSources` vs read-only queries.
- **Gate restated:** do not begin Task 1 until ADR-028 (PR #238) has merged to `main`.
```
