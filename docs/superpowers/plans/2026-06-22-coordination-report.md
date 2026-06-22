# Project Coordination Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /projects/:id/coordination-report[?packageId=]` + an MCP `coordination_report` tool that returns the three buildable TOC-coordination finding classes (required-but-absent, present-but-not-required, dangling cross-ref) as a typed, read-only report.

**Architecture:** A stateless aggregator — **no migration**. One DB query module composes three existing inputs (`listRequiredSections`, a thin present-set query, `getBrokenRefs`) inside one `REPEATABLE READ READ ONLY` transaction, then computes set differences in TypeScript. A REST handler and an MCP tool wrap it. `dangling_ref = is_broken ∖ required` reuses the tested broken-refs substrate.

**Tech Stack:** TypeScript/Node 22 (ESM), Express, `pg`, Zod v4, vitest (integration project, real Postgres), `@modelcontextprotocol/sdk`, OpenAPI 3.1 (`openapi.yaml` + redocly).

## Global Constraints

- **Decision-of-record:** `docs/adr/029-coordination-report.md`. Spec: `docs/superpowers/specs/2026-06-22-coordination-report-design.md`. Read the ADR first.
- **Branch `feat/api-coordination-report` off `origin/main`.** Execution is GATED: do **not** start until ADR-029 (the gate PR on `docs/adr-029-coordination-report`) has merged to `main`. PR `Closes #105`.
- **No new migration** — the report is derived and read-only.
- **`dangling_ref = is_broken ∖ required`**: a broken ref whose target section is in the required list is reported once as `required_not_present`, never as `dangling_ref`.
- **Empty required list ⇒ suppress `present_not_required`** and push the note `no required sections authored at this scope — present/required comparison skipped`. `required_not_present` is then empty; `dangling_ref` still runs.
- **Package scope = the package's island required rows + `package_specs` only** — never unioned with the baseline. Dangling refs are restricted to refs whose source spec is in the present set.
- **Errors:** malformed `:id`/`?packageId` → **400**; unknown project or `packageId`-not-in-project → **404**; else 500. No stack traces leave the process.
- **ESLint enforced:** `complexity` ≤10, `sonarjs/cognitive-complexity` ≤10, `max-lines-per-function` ≤50, `max-lines` ≤400, `no-console` error, `@typescript-eslint/no-explicit-any` error, no `!` outside tests, no type assertions across module boundaries. ESM relative imports use `.js`; `import type` for type-only imports.
- **Parameterized SQL only.** Module-boundary rule: `src/api/**` and `src/mcp/**` import DB only from the `../db/index.js` barrel; sibling files inside `src/db/queries/` import each other directly.
- **`openapi.yaml` updated same-PR** (ADR-026 contract gate). OpenAPI 3.1 nullable is `type: [..., 'null']` — **never** `nullable: true` (fails `redocly lint` in CI Build; cannot be reproduced locally on Node ≥26).
- **MCP tool never throws** — `toolError(...)` on any failure (repo gotcha). Use `z.uuid()` (Zod v4).
- **Commits:** Conventional Commits scoped per module (`feat(db):`, `feat(api):`, `feat(mcp):`). End each with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **DB for integration tests:** Postgres must be up and `DATABASE_URL` exported (test runners do not auto-load `.env`). Either `docker compose up -d postgres` then `set -a; source .env; set +a`, or run an isolated PG on 5434 with inline `DATABASE_URL`/`NODE_ENV=test` (see the repo's integration-db note). Run a single file with `pnpm exec vitest run --project integration <path>`.

---

### Task 1: Coordination query module

**Files:**
- Create: `src/db/queries/coordination.ts`
- Modify: `src/db/index.ts` (barrel — add the new export group)
- Test: `src/db/queries/coordination.integration.test.ts`

**Interfaces:**
- Consumes (all from sibling `src/db/queries/` files, imported directly):
  - `listRequiredSections(scope: RequiredScope, db?: Queryable): Promise<readonly RequiredSection[]>` and types `RequiredScope`, `RequiredSection { id; section; title: string | null; position }` — from `./required-sections.js`.
  - `getBrokenRefs(projectId: string, pool: Queryable): Promise<readonly BrokenRef[]>` and `BrokenRef { refId; sourceSpecId; sourceSpecSection; targetSpecSection: string | null; referenceText; availableFrom: readonly { libraryId; name }[] }` — from `./projects.js`.
  - `ProjectNotFoundError` (`./derive.js`), `PackageNotFoundError` (`./packages.js`), `DatabaseError` (`../errors.js`), `pool` (`../index.js`).
- Produces (barrelled in `src/db/index.ts`, consumed by Tasks 2 & 3):
  - `getCoordinationReport(projectId: string, packageId: string | undefined, db?: Pool): Promise<CoordinationReport>` — throws `ProjectNotFoundError` / `PackageNotFoundError`.
  - types `Finding`, `CoordinationSummary`, `CoordinationReport`.

- [ ] **Step 1: Write the failing test**

Create `src/db/queries/coordination.integration.test.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import {
  getCoordinationReport,
  type Finding,
} from './coordination.js';
import { setRequiredSections } from './required-sections.js';
import { ProjectNotFoundError } from './derive.js';
import { PackageNotFoundError } from './packages.js';

const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];

async function newProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`${name}-${suffix}`]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newProject: no id');
  projectIds.push(id);
  return id;
}
// Inserts a LIBRARY master (library_id set ⇒ project_id NULL by the
// (library_id IS NULL) <> (project_id IS NULL) CHECK), so it never references a
// project. Track the id and delete it in afterAll — specs.project_id is RESTRICT
// and library specs are not cascaded by project deletion (mirrors refs.integration.test.ts).
async function newSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title, `coord_${suffix}_${section}`]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`newSpec: no id for ${section}`);
  specIds.push(id);
  return id;
}
async function addProjectSpec(projectId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [projectId, specId, position]
  );
}
async function newPackage(projectId: string, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, name]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newPackage: no id');
  return id;
}
async function addPackageSpec(packageId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, $3)`,
    [packageId, specId, position]
  );
}
// A section-targeted ref; is_broken = (the target section has no spec in the project).
async function addRef(
  sourceSpecId: string,
  targetSection: string,
  referenceText: string,
  targetSpecId: string | null
): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'pr1', $2, 1) RETURNING id`,
    [sourceSpecId, referenceText]
  );
  const paragraphId = p.rows[0]?.id;
  if (paragraphId === undefined) throw new Error('addRef: no paragraph id');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section,
        target_spec_id, reference_text, is_broken)
     VALUES ($1, $2, 'section', $3, $4, $5, $6)`,
    [sourceSpecId, paragraphId, targetSection, targetSpecId, referenceText, targetSpecId === null]
  );
}
// Narrowing filter: ofType(fs, 'dangling_ref') is typed to the dangling variant,
// so variant-specific fields (.targetSpecSection, .section, .specId) typecheck.
function ofType<T extends Finding['type']>(
  fs: readonly Finding[],
  t: T
): Extract<Finding, { type: T }>[] {
  return fs.filter((f): f is Extract<Finding, { type: T }> => f.type === t);
}

afterAll(async () => {
  // Projects first (cascades project_specs/package_specs/required_sections/design_packages),
  // then the library specs we created (cascades their paragraphs + spec_references).
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [specIds]);
});

describe('getCoordinationReport', () => {
  it('returns exactly one finding of each class and excludes required-but-absent refs', async () => {
    const projectId = await newProject('coord-each');
    const specA = await newSpec('03 30 00', 'Concrete');   // present + required
    const specB = await newSpec('05 12 00', 'Steel');      // present, NOT required
    await addProjectSpec(projectId, specA, 1);
    await addProjectSpec(projectId, specB, 2);
    await setRequiredSections({ kind: 'baseline', projectId }, [
      { section: '03 30 00' },                              // present → no finding
      { section: '07 92 00', title: 'Joint Sealants' },     // required, absent → required_not_present
    ]);
    await addRef(specA, '09 91 00', 'see 09 91 00', null);  // neither → dangling_ref
    await addRef(specB, '07 92 00', 'see 07 92 00', null);  // broken but REQUIRED → NOT dangling

    const report = await getCoordinationReport(projectId, undefined);

    expect(report.projectId).toBe(projectId);
    expect(report.packageId).toBeNull();
    expect(ofType(report.findings, 'required_not_present').map((f) => f.section)).toEqual(['07 92 00']);
    expect(ofType(report.findings, 'present_not_required').map((f) => f.section)).toEqual(['05 12 00']);
    expect(ofType(report.findings, 'dangling_ref').map((f) => f.targetSpecSection)).toEqual(['09 91 00']);
    expect(report.summary).toEqual({
      requiredNotPresent: 1,
      presentNotRequired: 1,
      danglingRef: 1,
      total: 3,
    });
    expect(report.notes).toEqual([]);
  });

  it('suppresses present_not_required and emits a note when the required list is empty', async () => {
    const projectId = await newProject('coord-empty');
    const specA = await newSpec('03 30 00', 'Concrete');
    await addProjectSpec(projectId, specA, 1);
    await addRef(specA, '09 91 00', 'see 09 91 00', null); // dangling still runs

    const report = await getCoordinationReport(projectId, undefined);

    expect(ofType(report.findings, 'present_not_required')).toHaveLength(0);
    expect(ofType(report.findings, 'required_not_present')).toHaveLength(0);
    expect(ofType(report.findings, 'dangling_ref')).toHaveLength(1);
    expect(report.notes).toEqual([
      'no required sections authored at this scope — present/required comparison skipped',
    ]);
  });

  it('scopes to a package: package-island required vs package_specs, no baseline union', async () => {
    const projectId = await newProject('coord-pkg');
    const specA = await newSpec('03 30 00', 'Concrete');
    const specB = await newSpec('05 12 00', 'Steel');
    await addProjectSpec(projectId, specA, 1);
    await addProjectSpec(projectId, specB, 2);
    await setRequiredSections({ kind: 'baseline', projectId }, [{ section: '22 00 00' }]); // baseline only
    const packageId = await newPackage(projectId, 'CD set');
    await addPackageSpec(packageId, specA, 1); // package present = {03 30 00}
    await setRequiredSections({ kind: 'package', projectId, packageId }, [
      { section: '03 30 00' },                  // present → no finding
      { section: '23 00 00' },                  // required, absent → required_not_present
    ]);

    const report = await getCoordinationReport(projectId, packageId);

    expect(report.packageId).toBe(packageId);
    expect(ofType(report.findings, 'required_not_present').map((f) => f.section)).toEqual(['23 00 00']);
    // baseline's 22 00 00 must NOT leak in; specB (not in the package) must not appear
    expect(ofType(report.findings, 'present_not_required')).toHaveLength(0);
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    await expect(
      getCoordinationReport('00000000-0000-4000-8000-000000000000', undefined)
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('throws PackageNotFoundError for a packageId not in the project', async () => {
    const projectId = await newProject('coord-badpkg');
    await expect(
      getCoordinationReport(projectId, '00000000-0000-4000-8000-000000000000')
    ).rejects.toBeInstanceOf(PackageNotFoundError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project integration src/db/queries/coordination.integration.test.ts`
Expected: FAIL — `Cannot find module './coordination.js'` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/db/queries/coordination.ts`:

```typescript
import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { ProjectNotFoundError } from './derive.js';
import { PackageNotFoundError } from './packages.js';
import {
  listRequiredSections,
  type RequiredScope,
  type RequiredSection,
} from './required-sections.js';
import { getBrokenRefs, type BrokenRef } from './projects.js';

interface Queryable {
  query: Pool['query'];
}

export type Finding =
  | {
      readonly type: 'required_not_present';
      readonly section: string;
      readonly title: string | null;
      readonly requiredId: string;
    }
  | {
      readonly type: 'present_not_required';
      readonly section: string;
      readonly specId: string;
      readonly title: string;
    }
  | {
      readonly type: 'dangling_ref';
      readonly refId: string;
      readonly sourceSpecId: string;
      readonly sourceSpecSection: string;
      readonly targetSpecSection: string;
      readonly referenceText: string;
      readonly availableFrom: readonly { readonly libraryId: string; readonly name: string }[];
    };

export interface CoordinationSummary {
  readonly requiredNotPresent: number;
  readonly presentNotRequired: number;
  readonly danglingRef: number;
  readonly total: number;
}

export interface CoordinationReport {
  readonly projectId: string;
  readonly packageId: string | null;
  readonly findings: readonly Finding[];
  readonly summary: CoordinationSummary;
  readonly notes: readonly string[];
}

interface PresentSpec {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
}

const EMPTY_REQUIRED_NOTE =
  'no required sections authored at this scope — present/required comparison skipped';

async function assertScope(
  projectId: string,
  packageId: string | undefined,
  client: Queryable
): Promise<void> {
  const proj = await client.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if ((proj.rowCount ?? 0) === 0) {
    throw new ProjectNotFoundError(`project ${projectId} not found`);
  }
  if (packageId !== undefined) {
    const pkg = await client.query(
      `SELECT 1 FROM design_packages WHERE id = $1 AND project_id = $2`,
      [packageId, projectId]
    );
    if ((pkg.rowCount ?? 0) === 0) {
      throw new PackageNotFoundError(`package ${packageId} not found in project ${projectId}`);
    }
  }
}

async function readPresent(
  projectId: string,
  packageId: string | undefined,
  client: Queryable
): Promise<readonly PresentSpec[]> {
  const sql =
    packageId === undefined
      ? `SELECT s.id AS spec_id, s.section, s.title
         FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
         WHERE ps.project_id = $1 ORDER BY s.section`
      : `SELECT s.id AS spec_id, s.section, s.title
         FROM package_specs ks JOIN specs s ON s.id = ks.spec_id
         WHERE ks.package_id = $1 ORDER BY s.section`;
  const r = await client.query<{ spec_id: string; section: string; title: string }>(sql, [
    packageId ?? projectId,
  ]);
  return r.rows.map((row) => ({ specId: row.spec_id, section: row.section, title: row.title }));
}

function requiredScope(projectId: string, packageId: string | undefined): RequiredScope {
  return packageId === undefined
    ? { kind: 'baseline', projectId }
    : { kind: 'package', projectId, packageId };
}

function toDangling(
  b: BrokenRef,
  presentIds: ReadonlySet<string>,
  requiredSections: ReadonlySet<string>
): Finding | null {
  const target = b.targetSpecSection;
  if (target === null || !presentIds.has(b.sourceSpecId) || requiredSections.has(target)) {
    return null;
  }
  return {
    type: 'dangling_ref',
    refId: b.refId,
    sourceSpecId: b.sourceSpecId,
    sourceSpecSection: b.sourceSpecSection,
    targetSpecSection: target,
    referenceText: b.referenceText,
    availableFrom: b.availableFrom,
  };
}

function buildFindings(
  required: readonly RequiredSection[],
  present: readonly PresentSpec[],
  broken: readonly BrokenRef[]
): { readonly findings: readonly Finding[]; readonly notes: readonly string[] } {
  const requiredSections = new Set(required.map((r) => r.section));
  const presentSections = new Set(present.map((p) => p.section));
  const presentIds = new Set(present.map((p) => p.specId));

  const requiredNotPresent: Finding[] = required
    .filter((r) => !presentSections.has(r.section))
    .map((r) => ({
      type: 'required_not_present',
      section: r.section,
      title: r.title,
      requiredId: r.id,
    }));

  const empty = requiredSections.size === 0;
  const presentNotRequired: Finding[] = empty
    ? []
    : present
        .filter((p) => !requiredSections.has(p.section))
        .map((p) => ({
          type: 'present_not_required',
          section: p.section,
          specId: p.specId,
          title: p.title,
        }));

  const danglingRef = broken.flatMap((b) => {
    const f = toDangling(b, presentIds, requiredSections);
    return f ? [f] : [];
  });

  return {
    findings: [...requiredNotPresent, ...presentNotRequired, ...danglingRef],
    notes: empty ? [EMPTY_REQUIRED_NOTE] : [],
  };
}

function summarize(findings: readonly Finding[]): CoordinationSummary {
  const count = (t: Finding['type']): number => findings.filter((f) => f.type === t).length;
  return {
    requiredNotPresent: count('required_not_present'),
    presentNotRequired: count('present_not_required'),
    danglingRef: count('dangling_ref'),
    total: findings.length,
  };
}

export async function getCoordinationReport(
  projectId: string,
  packageId: string | undefined,
  db: Pool = pool
): Promise<CoordinationReport> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await assertScope(projectId, packageId, client);
    const required = await listRequiredSections(requiredScope(projectId, packageId), client);
    const present = await readPresent(projectId, packageId, client);
    const broken = await getBrokenRefs(projectId, client);
    await client.query('COMMIT');
    const { findings, notes } = buildFindings(required, present, broken);
    return { projectId, packageId: packageId ?? null, findings, summary: summarize(findings), notes };
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getCoordinationReport failed for project ${projectId}`, { cause: err });
  } finally {
    if (client) client.release();
  }
}
```

Then add to `src/db/index.ts` a new export group (match the file's existing grouped `export { … } from './queries/X.js'` style):

```typescript
export { getCoordinationReport } from './queries/coordination.js';
export type { Finding, CoordinationSummary, CoordinationReport } from './queries/coordination.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run --project integration src/db/queries/coordination.integration.test.ts`
Expected: PASS — 5/5.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: clean (ESLint + `tsc --noEmit` + prettier). If `max-lines-per-function` trips, the helper split above already keeps each function < 50 lines — do not inline them back.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/coordination.ts src/db/queries/coordination.integration.test.ts src/db/index.ts
git commit -m "feat(db): coordination report query — required/present/dangling findings

Composes listRequiredSections + a thin present-set query + getBrokenRefs in
one REPEATABLE READ READ ONLY txn; dangling_ref = is_broken ∖ required.
Open Finding union; empty-required suppression; package-island scope.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: REST endpoint + OpenAPI + contract

**Files:**
- Create: `src/api/coordination.ts`
- Modify: `src/api/router.ts` (import + one route)
- Modify: `openapi.yaml` (one path + five schemas)
- Modify: `src/api/contract.integration.test.ts` (one `RESPONSE_ALLOWLIST` entry)
- Test: `src/api/coordination.integration.test.ts`

**Interfaces:**
- Consumes: `getCoordinationReport`, `ProjectNotFoundError`, `PackageNotFoundError`, and the `CoordinationReport` type — all from `../db/index.js` (barrel).
- Produces: `getCoordinationReportHandler(req, res): Promise<void>`; route `GET /projects/:id/coordination-report`.

- [ ] **Step 1: Write the failing test**

Create `src/api/coordination.integration.test.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import { setRequiredSections } from '../db/queries/required-sections.js';

let server: Server;
let baseUrl: string;
let projectId: string;
let specId: string;
const suffix = randomUUID().slice(0, 8);

async function req(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { method });
  return { status: res.status, body: await res.json() };
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
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 3000}`;

  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`coord-api-${suffix}`]
  );
  projectId = p.rows[0]!.id;
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('05 12 00', 'Steel', $1, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [`coordapi_${suffix}`]
  );
  specId = spec.rows[0]!.id;
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
  await setRequiredSections({ kind: 'baseline', projectId }, [{ section: '07 92 00' }]);
});

afterAll(async () => {
  // Project first (cascades project_specs + required_sections), then the library spec.
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('coordination-report API', () => {
  it('GET returns the report envelope with findings + summary', async () => {
    const r = await req('GET', `/projects/${projectId}/coordination-report`);
    expect(r.status).toBe(200);
    const body = r.body as { success: boolean; data: { summary: { total: number }; findings: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.summary.total).toBe(body.data.findings.length);
    // present 05 12 00 (not required) + required 07 92 00 (absent) = 2 findings
    expect(body.data.summary.total).toBe(2);
  });

  it('400 on a malformed project id', async () => {
    expect((await req('GET', `/projects/not-a-uuid/coordination-report`)).status).toBe(400);
  });

  it('400 on a malformed packageId query', async () => {
    expect(
      (await req('GET', `/projects/${projectId}/coordination-report?packageId=not-a-uuid`)).status
    ).toBe(400);
  });

  it('404 on an unknown project', async () => {
    expect(
      (await req('GET', `/projects/00000000-0000-4000-8000-000000000000/coordination-report`)).status
    ).toBe(404);
  });

  it('404 on a packageId not in the project', async () => {
    expect(
      (
        await req(
          'GET',
          `/projects/${projectId}/coordination-report?packageId=00000000-0000-4000-8000-000000000000`
        )
      ).status
    ).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project integration src/api/coordination.integration.test.ts`
Expected: FAIL — the route 404s (not registered) so the 200 test fails.

- [ ] **Step 3: Write the handler**

Create `src/api/coordination.ts`:

```typescript
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getCoordinationReport, ProjectNotFoundError, PackageNotFoundError } from '../db/index.js';

function mapError(err: unknown, res: Response): void {
  if (err instanceof ProjectNotFoundError || err instanceof PackageNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'coordination report failed' });
}

export async function getCoordinationReportHandler(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  let packageId: string | undefined;
  const rawPackageId = req.query['packageId'];
  if (rawPackageId !== undefined) {
    const pkg = z.uuid().safeParse(rawPackageId);
    if (!pkg.success) {
      res.status(400).json({ success: false, error: 'invalid package id' });
      return;
    }
    packageId = pkg.data;
  }
  try {
    const report = await getCoordinationReport(id.data, packageId);
    res.status(200).json({ success: true, data: report });
  } catch (err) {
    mapError(err, res);
  }
}
```

- [ ] **Step 4: Register the route**

In `src/api/router.ts`, add the import alongside the other handler imports:

```typescript
import { getCoordinationReportHandler } from './coordination.js';
```

And register the route next to the other `/projects/:id` reads (e.g. directly after the `references/broken` route, line ~143):

```typescript
router.get('/projects/:id/coordination-report', getCoordinationReportHandler);
```

- [ ] **Step 5: Document it in `openapi.yaml`**

Add this path (place it near the other `/projects/{id}/...` paths). Mirror the `required-sections` GET envelope style exactly:

```yaml
  /projects/{id}/coordination-report:
    get:
      operationId: getCoordinationReport
      summary: Project coordination report — required/present/reference findings
      tags: [projects]
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string, format: uuid }
        - name: packageId
          in: query
          required: false
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: Coordination report
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data: { $ref: '#/components/schemas/CoordinationReport' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { $ref: '#/components/responses/NotFound' }
        '500': { $ref: '#/components/responses/InternalServerError' }
```

Add these schemas under `components/schemas` (after `RequiredSection*`):

```yaml
    CoordinationReport:
      type: object
      required: [projectId, packageId, findings, summary, notes]
      properties:
        projectId: { type: string, format: uuid }
        packageId: { type: [string, 'null'], format: uuid }
        findings:
          type: array
          items: { $ref: '#/components/schemas/CoordinationFinding' }
        summary: { $ref: '#/components/schemas/CoordinationSummary' }
        notes:
          type: array
          items: { type: string }
    CoordinationSummary:
      type: object
      required: [requiredNotPresent, presentNotRequired, danglingRef, total]
      properties:
        requiredNotPresent: { type: integer }
        presentNotRequired: { type: integer }
        danglingRef: { type: integer }
        total: { type: integer }
    CoordinationFinding:
      oneOf:
        - $ref: '#/components/schemas/FindingRequiredNotPresent'
        - $ref: '#/components/schemas/FindingPresentNotRequired'
        - $ref: '#/components/schemas/FindingDanglingRef'
      discriminator:
        propertyName: type
        mapping:
          required_not_present: '#/components/schemas/FindingRequiredNotPresent'
          present_not_required: '#/components/schemas/FindingPresentNotRequired'
          dangling_ref: '#/components/schemas/FindingDanglingRef'
    FindingRequiredNotPresent:
      type: object
      required: [type, section, title, requiredId]
      properties:
        type: { type: string, enum: [required_not_present] }
        section: { type: string }
        title: { type: [string, 'null'] }
        requiredId: { type: string, format: uuid }
    FindingPresentNotRequired:
      type: object
      required: [type, section, specId, title]
      properties:
        type: { type: string, enum: [present_not_required] }
        section: { type: string }
        specId: { type: string, format: uuid }
        title: { type: string }
    FindingDanglingRef:
      type: object
      required: [type, refId, sourceSpecId, sourceSpecSection, targetSpecSection, referenceText, availableFrom]
      properties:
        type: { type: string, enum: [dangling_ref] }
        refId: { type: string, format: uuid }
        sourceSpecId: { type: string, format: uuid }
        sourceSpecSection: { type: string }
        targetSpecSection: { type: string }
        referenceText: { type: string }
        availableFrom:
          type: array
          items:
            type: object
            required: [libraryId, name]
            properties:
              libraryId: { type: string, format: uuid }
              name: { type: string }
```

- [ ] **Step 6: Allowlist the op in the contract test**

In `src/api/contract.integration.test.ts`, add one line to `RESPONSE_ALLOWLIST` (matching the sibling `get /projects/{}/required-sections` and `get /projects/{}/references/broken` entries — the dedicated API test above carries the real response-shape assertions):

```typescript
  'get /projects/{}/coordination-report',
```

- [ ] **Step 7: Verify redocly accepts the spec (CI Build parity)**

Run: `pnpm exec redocly lint openapi.yaml` (if Node ≥26 breaks redoc locally, this is the one check that only goes green in CI — confirm no `nullable: true` slipped in; all nullables use `type: [..., 'null']`).
Expected: no errors (warnings tolerated as elsewhere).

- [ ] **Step 8: Run the API test + contract gate**

Run: `pnpm exec vitest run --project integration src/api/coordination.integration.test.ts src/api/contract.integration.test.ts`
Expected: PASS — API 5/5; contract `route↔spec` + `response-covered-or-allowlisted` green.

- [ ] **Step 9: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/api/coordination.ts src/api/router.ts openapi.yaml src/api/contract.integration.test.ts src/api/coordination.integration.test.ts
git commit -m "feat(api): GET /projects/:id/coordination-report

Read-only report endpoint over getCoordinationReport; optional ?packageId
scope. 400 on malformed ids, 404 on unknown project/package. openapi.yaml
path + Finding oneOf schemas; contract gate green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: MCP `coordination_report` tool

**Files:**
- Modify: `src/mcp/handlers.ts` (add `handleCoordinationReport`)
- Modify: `src/mcp/tools.ts` (add `registerCoordinationTools`, wire into `registerTools`)
- Test: `src/mcp/coordination.integration.test.ts`

**Interfaces:**
- Consumes: `getCoordinationReport`, `ProjectNotFoundError`, `PackageNotFoundError` from `../db/index.js`; `toolError`, `ToolResult` from the existing handlers module.
- Produces: `handleCoordinationReport({ projectId, packageId? }): Promise<ToolResult>`; registered tool `coordination_report`.

- [ ] **Step 1: Write the failing test**

Create `src/mcp/coordination.integration.test.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { handleCoordinationReport } from './handlers.js';

const suffix = randomUUID().slice(0, 8);
let projectId: string;

beforeAll(async () => {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`coord-mcp-${suffix}`]
  );
  projectId = p.rows[0]!.id;
});
afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('handleCoordinationReport (MCP)', () => {
  it('returns a JSON text report for a known project', async () => {
    const res = await handleCoordinationReport({ projectId });
    expect('isError' in res).toBe(false);
    const text = res.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { projectId: string; summary: { total: number } };
    expect(parsed.projectId).toBe(projectId);
    expect(parsed.summary.total).toBe(0);
  });

  it('returns isError (never throws) for an unknown project', async () => {
    const res = await handleCoordinationReport({
      projectId: '00000000-0000-4000-8000-000000000000',
    });
    expect('isError' in res && res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project integration src/mcp/coordination.integration.test.ts`
Expected: FAIL — `handleCoordinationReport` is not exported.

- [ ] **Step 3: Add the handler**

In `src/mcp/handlers.ts`, extend the existing `../db/index.js` import to include `getCoordinationReport`, `ProjectNotFoundError`, `PackageNotFoundError`, then add:

```typescript
export async function handleCoordinationReport({
  projectId,
  packageId,
}: {
  projectId: string;
  packageId?: string;
}): Promise<ToolResult> {
  try {
    const report = await getCoordinationReport(projectId, packageId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PackageNotFoundError) {
      return toolError(err.message);
    }
    return toolError('Internal error — coordination report failed');
  }
}
```

- [ ] **Step 4: Register the tool**

In `src/mcp/tools.ts`, add `handleCoordinationReport` to the handlers import, then add a registrar and call it from `registerTools`:

```typescript
function registerCoordinationTools(server: McpServer): void {
  server.registerTool(
    'coordination_report',
    {
      description:
        'Project errors-and-omissions report: required-but-absent sections, ' +
        'present-but-not-required specs, and dangling cross-references. Optional ' +
        'packageId scopes to one design package. Requires a projectId (see list_projects).',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
        packageId: z.uuid().optional().describe('Optional design-package UUID to scope the report'),
      },
    },
    handleCoordinationReport
  );
}
```

In `registerTools(server)`, add the call alongside the others:

```typescript
  registerCoordinationTools(server);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run --project integration src/mcp/coordination.integration.test.ts`
Expected: PASS — 2/2.

- [ ] **Step 6: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/tools.ts src/mcp/coordination.integration.test.ts
git commit -m "feat(mcp): coordination_report tool

Wraps getCoordinationReport; never throws (toolError on unknown project/
package or internal failure); optional packageId scope.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (before opening the PR)

1. **Whole suite + lint + build:**
   - `pnpm lint` (ESLint + `tsc --noEmit` + prettier) — clean.
   - `pnpm build` — `tsc` succeeds.
   - `pnpm test` (unit, no DB) — green.
   - `set -a; source .env; set +a` then `pnpm test:integration` — green (the pre-existing CPI parser test may fail **locally only** on Node ≥26; it passes in CI and this branch touches no parser files — do not chase it).
2. **Manual API smoke** (server on a DB with the migrations applied): `POST /projects` → `POST /projects/:id/specs` (a couple) → `PUT /projects/:id/required-sections` naming one absent section + leaving one present spec unrequired + one spec citing a third absent section → `GET /projects/:id/coordination-report` shows one finding of each type with a correct summary; empty required list → `present_not_required` absent + note present.
3. **MCP:** `POST /mcp` `tools/call` `coordination_report` with `{projectId}` and `{projectId, packageId}` → matching JSON; unknown project → `isError`.
4. **PR:** open against `main`, `Closes #105`, reference ADR-029; Testing checklist with tickable boxes; leave for CodeRabbit + thewrz merge (admin-merge pattern). Move #105 → In review when the PR opens.

## Out of scope (do not build)

- `unmapped_revit_element` (#103), `keynote_orphan` (ADR-016), `inference_conflict`/`parse_warning` (#56) — deferred union variants, added later with no contract change.
- Auto-remediation; UI rendering; the demo `coordination` feature-flag flip (Phase 5, examples-only).
- Any change to `/references/broken` semantics — it stays the distinct membership-relative view.
- Persisting/caching findings; any new migration.
```
