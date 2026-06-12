# Copy-on-Derive (#94) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project sections become owned copies — `POST /projects/:id/specs` takes a section number, resolves it through an ordered `project_sources` list (company/client masters only), and clones the winning master (spec row + paragraph tree + outgoing refs) into a project-owned spec with full lineage; removal of edited copies is guarded behind `?force=true`; existing aliased projects are backfilled.

**Architecture:** Two migrations (018 schema, 019 backfill). New query module `src/db/queries/derive.ts` does the SQL set-based clone in one transaction on a dedicated client (never round-trips through `getSpecTree`/`buildTree` — that drops empty paragraphs). `projects.ts` gains source-list create/read + `availableFrom` on broken refs. API layer swaps `{specId}` for `{section}` and adds typed-error → HTTP status mapping.

**Tech Stack:** TypeScript (strict), Express 5, PostgreSQL (pg), node-pg-migrate (TS migrations), Zod v4, Vitest (unit + serialized integration projects).

**Design authority:** `docs/superpowers/specs/2026-06-11-issue-094-design.md`. Do not deviate from its decision table.

**Out of scope:** re-pull/rebase, per-section source override, library→library derivation, design packages (#95), UI, MCP changes.

---

## Environment facts (read first)

- Worktree: `/home/adam/github/SpecR/.worktrees/feat/issue-94`, branch `feat/issue-94`. Never commit to main.
- Integration DB: host port 5432 is TAKEN. Use an isolated PG on **5434**:
  ```bash
  docker run --rm -d --name specr-pg-94 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=specr -p 5434:5432 postgres:16
  ```
  Nothing auto-loads `.env` — every `pnpm migrate|seed|test:integration` command needs inline env:
  ```bash
  DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
  ```
- `pnpm test` = unit only (no DB). `pnpm test:integration` = `*.integration.test.ts` (needs DB, runs serially).
- ESLint: max 50 lines/function, max 400 lines/file, complexity 10, no `any`, no console. `pnpm lint` = eslint + tsc + prettier check. Run `pnpm format` before every commit.
- Commits: Conventional Commits, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- pg error mapping helper exists: `src/lib/pg-errors.ts` (`getPgCode` walks ONE level of `DatabaseError.cause` — so wrap raw pg errors exactly once).
- Existing transaction pattern to copy: `persistParsedSpec` in `src/db/queries/specs.ts` (client from `pool.connect()`, BEGIN/COMMIT, best-effort ROLLBACK in catch, `client.release()` in finally).

### Current schema columns (for clone INSERTs — copy exactly)

`specs`: `id, section, title, source, created_at, updated_at, library_id, project_id, parent_spec_id, origin_version, content_version, origin_meta`
`paragraphs`: `id, spec_id, parent_id, node_type, text, position, vanish, revit_param, base_version, created_at, updated_at, conflicts` (+ `origin_paragraph_id` after migration 018)
`spec_references`: `id, source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, target_paragraph_id, standard_code, reference_text, is_broken, created_at`
`project_specs`: `project_id, spec_id (FK RESTRICT), position, added_at` — PK `(project_id, spec_id)`, `UNIQUE (project_id, position)`
`libraries`: `id, tier (reference|company|client), name (UNIQUE), owner, parent_library_id, created_at`
Partial unique indexes on specs: `(section, source, library_id) WHERE library_id IS NOT NULL`, `(section, project_id) WHERE project_id IS NOT NULL` — the latter is what makes "duplicate section in project" a pg `23505`.

---

### Task 1: Dev database up + baseline green

No commit. Setup only.

- [ ] **Step 1: Start isolated PG and migrate/seed**

```bash
cd /home/adam/github/SpecR/.worktrees/feat/issue-94
docker run --rm -d --name specr-pg-94 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=specr -p 5434:5432 postgres:16
sleep 3
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm seed
```

Expected: 17 migrations run, seed completes.

- [ ] **Step 2: Baseline green**

```bash
pnpm lint && pnpm test
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration
```

Expected: all pass. If baseline is red, STOP and report — do not build on a red base.

---

### Task 2: Migration 018 — `project_sources` + `paragraphs.origin_paragraph_id`

**Files:**
- Create: `src/db/migrations/018_project_sources_and_paragraph_lineage.ts`

Schema is not a test target (CLAUDE.md). Verification = up/down/up cycle.

- [ ] **Step 1: Write the migration**

Write this as the complete file:

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D3 — ordered per-project source list; copy-on-derive resolution
// (issue #94) walks it by priority. Plus paragraph-grain lineage: the future
// re-pull/rebase command (Phase 3 diff matches paragraphs by UUID) needs the
// clone-time paragraph mapping, which cannot be reconstructed later.
//
// Tier restriction (sources must be company|client, never reference) is
// enforced at the query layer (src/db/queries/projects.ts) — a cross-table
// CHECK on libraries.tier would require a trigger.

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('project_sources', {
    project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' },
    library_id: { type: 'uuid', notNull: true, references: 'libraries' },
    priority: { type: 'integer', notNull: true },
  });
  pgm.addConstraint(
    'project_sources',
    'project_sources_pkey',
    'PRIMARY KEY (project_id, library_id)'
  );
  pgm.addConstraint('project_sources', 'project_sources_priority_check', {
    check: 'priority >= 1',
  });
  pgm.addConstraint(
    'project_sources',
    'project_sources_project_priority_unique',
    'UNIQUE (project_id, priority)'
  );

  pgm.addColumns('paragraphs', {
    origin_paragraph_id: { type: 'uuid', references: 'paragraphs', onDelete: 'SET NULL' },
  });
  pgm.createIndex('paragraphs', 'origin_paragraph_id', {
    name: 'paragraphs_origin_idx',
    where: 'origin_paragraph_id IS NOT NULL',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('paragraphs', 'origin_paragraph_id', { name: 'paragraphs_origin_idx' });
  pgm.dropColumns('paragraphs', ['origin_paragraph_id']);
  pgm.dropTable('project_sources');
};
```

- [ ] **Step 2: Verify reversibility (up → down → up)**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate:down
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
docker exec specr-pg-94 psql -U postgres -d specr -c "\d project_sources" -c "\d paragraphs" | grep -E "origin_paragraph_id|priority"
```

Expected: all three migrate commands succeed; `origin_paragraph_id | uuid` and `priority | integer` appear.

- [ ] **Step 3: Lint + commit**

```bash
pnpm format && pnpm lint
git add src/db/migrations/018_project_sources_and_paragraph_lineage.ts
git commit -m "feat(db): project_sources table + paragraphs.origin_paragraph_id (ADR-015 D3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `derive.ts` — `addSectionToProject` (resolution + SQL clone)

**Files:**
- Create: `src/db/queries/derive.ts`
- Create: `src/db/queries/derive.integration.test.ts`
- Modify: `src/db/index.ts` (barrel exports)

TDD at the module boundary against real PostgreSQL.

- [ ] **Step 1: Write the failing integration tests**

Create `src/db/queries/derive.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../index.js';
import {
  addSectionToProject,
  ProjectNotFoundError,
  SectionUnresolvedError,
} from './derive.js';
import { getPgCode } from '../../lib/pg-errors.js';

// ── SQL helpers (raw inserts — tests must not depend on the code under test) ──

async function insertLibrary(tier: string, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ($1, $2) RETURNING id`,
    [tier, name]
  );
  if (!r.rows[0]) throw new Error('insertLibrary failed');
  return r.rows[0].id;
}

async function insertMaster(libraryId: string, section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, content_version, origin_meta)
     VALUES ($1, $2, 'unknown', $3, 3, '{"filename":"x.docx","sha256":"abc","loader":"docx"}')
     RETURNING id`,
    [section, title, libraryId]
  );
  if (!r.rows[0]) throw new Error('insertMaster failed');
  return r.rows[0].id;
}

async function insertParagraph(
  specId: string,
  parentId: string | null,
  nodeType: string,
  text: string,
  position: number,
  extra?: { vanish?: boolean; conflicts?: string }
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish, conflicts)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
    [specId, parentId, nodeType, text, position, extra?.vanish ?? false, extra?.conflicts ?? '[]']
  );
  if (!r.rows[0]) throw new Error('insertParagraph failed');
  return r.rows[0].id;
}

async function insertProjectWithSources(
  name: string,
  libraryIds: readonly string[]
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  if (!r.rows[0]) throw new Error('insertProject failed');
  const projectId = r.rows[0].id;
  for (const [i, libId] of libraryIds.entries()) {
    await pool.query(
      `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, $3)`,
      [projectId, libId, i + 1]
    );
  }
  return projectId;
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const suffix = randomUUID().slice(0, 8);
let companyLib: string;
let clientLib: string;
let masterId: string; // '03 30 00' in company lib — 4-paragraph tree incl. empty text
let masterParaIds: string[] = [];
const createdProjects: string[] = [];

beforeAll(async () => {
  companyLib = await insertLibrary('company', `Derive Co ${suffix}`);
  clientLib = await insertLibrary('client', `Derive Client ${suffix}`);
  masterId = await insertMaster(companyLib, '03 30 00', 'Concrete');
  // tree: part → article → pr1; plus an EMPTY-text pr1 (losslessness pin) and a
  // vanish+conflicts paragraph.
  const part = await insertParagraph(masterId, null, 'part', 'PART 1 GENERAL', 1);
  const article = await insertParagraph(masterId, part, 'article', 'SUMMARY', 1);
  const pr1 = await insertParagraph(masterId, article, 'pr1', 'Section includes concrete.', 1, {
    vanish: true,
    conflicts: '[{"signal":2,"reportedIlvl":1,"reportedNodeType":"pr2"}]',
  });
  const empty = await insertParagraph(masterId, article, 'pr1', '', 2);
  masterParaIds = [part, article, pr1, empty];
  // company lib also holds 09 91 00 (fallback + ref-repair target)
  await insertMaster(companyLib, '09 91 00', 'Painting');
  // both libs hold 04 20 00 (shadow advisory)
  await insertMaster(companyLib, '04 20 00', 'Unit Masonry');
  await insertMaster(clientLib, '04 20 00', 'Unit Masonry (Client)');
  // master ref: 03 30 00 → 09 91 00 (section), plus a standard ref
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, reference_text)
     VALUES ($1, $2, 'section', '09 91 00', 'See Section 09 91 00')`,
    [masterId, pr1]
  );
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, standard_code, reference_text)
     VALUES ($1, $2, 'standard', 'ASTM C150', 'ASTM C150')`,
    [masterId, pr1]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM specs WHERE project_id IS NOT NULL AND project_id = ANY($1)', [
    createdProjects,
  ]);
  await pool.query('DELETE FROM specs WHERE library_id = ANY($1)', [[companyLib, clientLib]]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1)', [[companyLib, clientLib]]);
});

async function newProject(libs: readonly string[]): Promise<string> {
  const id = await insertProjectWithSources(`derive-test-${randomUUID().slice(0, 8)}`, libs);
  createdProjects.push(id);
  return id;
}

describe('addSectionToProject — clone correctness', () => {
  let projectId: string;
  let cloneId: string;

  beforeAll(async () => {
    projectId = await newProject([clientLib, companyLib]);
    const result = await addSectionToProject(projectId, '03 30 00', pool);
    cloneId = result.specId;
    expect(result.section).toBe('03 30 00');
    expect(result.position).toBe(1);
    expect(result.source).toEqual({ libraryId: companyLib, name: `Derive Co ${suffix}` });
    expect(result.shadowed).toBeUndefined();
  });

  it('clone spec row carries lineage: parent, origin_version, content_version=1, origin_meta', async () => {
    const r = await pool.query<{
      project_id: string;
      library_id: string | null;
      parent_spec_id: string;
      origin_version: number;
      content_version: number;
      origin_meta: { filename: string } | null;
    }>(
      `SELECT project_id, library_id, parent_spec_id, origin_version, content_version, origin_meta
       FROM specs WHERE id = $1`,
      [cloneId]
    );
    const row = r.rows[0];
    expect(cloneId).not.toBe(masterId);
    expect(row?.project_id).toBe(projectId);
    expect(row?.library_id).toBeNull();
    expect(row?.parent_spec_id).toBe(masterId);
    expect(row?.origin_version).toBe(3);
    expect(row?.content_version).toBe(1);
    expect(row?.origin_meta?.filename).toBe('x.docx');
  });

  it('clone is lossless: every master paragraph matched 1:1 on content + structure via origin map', async () => {
    // join clone rows to master rows through origin_paragraph_id and compare
    // content columns + remapped parent structure entirely in SQL.
    const r = await pool.query<{ total: string; matched: string; parent_ok: string }>(
      `SELECT
         (SELECT COUNT(*) FROM paragraphs WHERE spec_id = $1) AS total,
         (SELECT COUNT(*) FROM paragraphs c
            JOIN paragraphs m ON m.id = c.origin_paragraph_id
           WHERE c.spec_id = $2 AND m.spec_id = $1
             AND c.node_type = m.node_type AND c.text = m.text
             AND c.position = m.position AND c.vanish = m.vanish
             AND c.base_version = m.base_version
             AND c.conflicts::text = m.conflicts::text) AS matched,
         (SELECT COUNT(*) FROM paragraphs c
            JOIN paragraphs m ON m.id = c.origin_paragraph_id
            LEFT JOIN paragraphs cp ON cp.id = c.parent_id
           WHERE c.spec_id = $2
             AND (cp.origin_paragraph_id IS NOT DISTINCT FROM m.parent_id)) AS parent_ok`,
      [masterId, cloneId]
    );
    const row = r.rows[0];
    expect(row?.total).toBe('4'); // includes the empty-text paragraph
    expect(row?.matched).toBe(row?.total);
    expect(row?.parent_ok).toBe(row?.total);
  });

  it('all clone paragraph UUIDs are new and the origin map is complete', async () => {
    const r = await pool.query<{ id: string; origin_paragraph_id: string | null }>(
      `SELECT id, origin_paragraph_id FROM paragraphs WHERE spec_id = $1`,
      [cloneId]
    );
    const origins = r.rows.map((p) => p.origin_paragraph_id);
    expect(new Set(origins).size).toBe(masterParaIds.length);
    for (const p of r.rows) {
      expect(masterParaIds).not.toContain(p.id);
      expect(masterParaIds).toContain(p.origin_paragraph_id);
    }
  });

  it('clone refs: source ids remapped; section target broken (09 91 00 not in project); standard ref intact', async () => {
    const r = await pool.query<{
      target_type: string;
      target_spec_section: string | null;
      target_spec_id: string | null;
      is_broken: boolean;
      source_paragraph_id: string;
    }>(
      `SELECT target_type, target_spec_section, target_spec_id, is_broken, source_paragraph_id
       FROM spec_references WHERE source_spec_id = $1 ORDER BY target_type`,
      [cloneId]
    );
    expect(r.rows).toHaveLength(2);
    const section = r.rows.find((x) => x.target_type === 'section');
    const standard = r.rows.find((x) => x.target_type === 'standard');
    expect(section?.is_broken).toBe(true);
    expect(section?.target_spec_id).toBeNull();
    expect(section?.target_spec_section).toBe('09 91 00');
    expect(standard?.is_broken).toBe(false);
    expect(masterParaIds).not.toContain(section?.source_paragraph_id);
  });

  it('HEADLINE: editing the project copy leaves the master untouched', async () => {
    const clonePara = await pool.query<{ id: string; origin_paragraph_id: string }>(
      `SELECT id, origin_paragraph_id FROM paragraphs
       WHERE spec_id = $1 AND node_type = 'pr1' AND text <> ''`,
      [cloneId]
    );
    const cp = clonePara.rows[0];
    expect(cp).toBeDefined();
    await pool.query(`UPDATE paragraphs SET text = 'EDITED IN PROJECT' WHERE id = $1`, [cp?.id]);
    const master = await pool.query<{ text: string }>(
      `SELECT text FROM paragraphs WHERE id = $1`,
      [cp?.origin_paragraph_id]
    );
    expect(master.rows[0]?.text).toBe('Section includes concrete.');
  });

  it('adding the target section repairs the broken clone ref to point at the NEW clone; master ref untouched', async () => {
    const added = await addSectionToProject(projectId, '09 91 00', pool);
    const repaired = await pool.query<{ target_spec_id: string | null; is_broken: boolean }>(
      `SELECT target_spec_id, is_broken FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'section'`,
      [cloneId]
    );
    expect(repaired.rows[0]?.is_broken).toBe(false);
    expect(repaired.rows[0]?.target_spec_id).toBe(added.specId);
    const masterRef = await pool.query<{ target_spec_id: string | null }>(
      `SELECT target_spec_id FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'section'`,
      [masterId]
    );
    expect(masterRef.rows[0]?.target_spec_id).toBeNull();
  });

  it('duplicate section in project → pg 23505 (409 at the API layer)', async () => {
    await expect(addSectionToProject(projectId, '03 30 00', pool)).rejects.toSatisfy(
      (err: unknown) => getPgCode(err) === '23505'
    );
  });
});

describe('addSectionToProject — resolution', () => {
  it('fallback: section absent from client master (priority 1) resolves from company master (priority 2)', async () => {
    const projectId = await newProject([clientLib, companyLib]);
    const result = await addSectionToProject(projectId, '09 91 00', pool);
    expect(result.source.libraryId).toBe(companyLib);
    expect(result.shadowed).toBeUndefined();
  });

  it('shadow advisory: section in both sources → winner is priority 1, shadowed lists the other', async () => {
    const projectId = await newProject([clientLib, companyLib]);
    const result = await addSectionToProject(projectId, '04 20 00', pool);
    expect(result.source.libraryId).toBe(clientLib);
    expect(result.shadowed).toEqual([
      { libraryId: companyLib, name: `Derive Co ${suffix}` },
    ]);
  });

  it('no source holds the section → SectionUnresolvedError', async () => {
    const projectId = await newProject([clientLib]);
    await expect(addSectionToProject(projectId, '99 99 99', pool)).rejects.toBeInstanceOf(
      SectionUnresolvedError
    );
  });

  it('unknown project → ProjectNotFoundError', async () => {
    await expect(
      addSectionToProject('00000000-0000-0000-0000-000000000000', '03 30 00', pool)
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration -- derive
```

Expected: FAIL — `Cannot find module './derive.js'` (or equivalent).

- [ ] **Step 3: Implement `src/db/queries/derive.ts`**

```typescript
import type { Pool, PoolClient } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { logger } from '../../lib/logger.js';

/** Copy-on-derive (ADR-015 D2/D3, issue #94): project sections are owned
 *  clones of master specs, resolved through the project's ordered source list.
 *  The clone is SQL set-based and lossless by construction — it never
 *  round-trips through getSpecTree/buildTree (which drops empty paragraphs). */

/** Target project does not exist → 404 at the API layer. */
export class ProjectNotFoundError extends DatabaseError {}
/** No source library of the project holds the section → 422 at the API layer. */
export class SectionUnresolvedError extends DatabaseError {}

export interface SourceLibraryRef {
  readonly libraryId: string;
  readonly name: string;
}

export interface AddSectionResult {
  readonly specId: string;
  readonly section: string;
  readonly position: number;
  readonly source: SourceLibraryRef;
  readonly shadowed?: readonly SourceLibraryRef[];
}

interface ResolutionRow {
  readonly spec_id: string;
  readonly library_id: string;
  readonly name: string;
}

interface Resolution {
  readonly master: ResolutionRow;
  readonly shadowed: readonly SourceLibraryRef[];
}

/** Walk project_sources by priority; first library holding the section wins.
 *  Other sources that also hold it are surfaced as the shadowed advisory. */
async function resolveSection(
  projectId: string,
  section: string,
  client: PoolClient
): Promise<Resolution> {
  const res = await client.query<ResolutionRow>(
    `SELECT s.id AS spec_id, ps.library_id, l.name
     FROM project_sources ps
     JOIN libraries l ON l.id = ps.library_id
     JOIN specs s ON s.library_id = ps.library_id AND s.section = $2
     WHERE ps.project_id = $1
     ORDER BY ps.priority, s.created_at, s.id`,
    [projectId, section]
  );
  const master = res.rows[0];
  if (!master) {
    const proj = await client.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (proj.rowCount === 0) {
      throw new ProjectNotFoundError(`addSectionToProject: project ${projectId} not found`);
    }
    throw new SectionUnresolvedError(
      `addSectionToProject: no source library of project ${projectId} holds section ${section}`
    );
  }
  const shadowed = new Map<string, SourceLibraryRef>();
  for (const row of res.rows.slice(1)) {
    if (row.library_id !== master.library_id && !shadowed.has(row.library_id)) {
      shadowed.set(row.library_id, { libraryId: row.library_id, name: row.name });
    }
  }
  return { master, shadowed: [...shadowed.values()] };
}

/** Clone the spec row; lineage per ADR-015 D2 (origin_meta keeps file provenance true). */
async function cloneSpecRow(
  projectId: string,
  masterId: string,
  client: PoolClient
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO specs
       (section, title, source, project_id, parent_spec_id, origin_version,
        content_version, origin_meta)
     SELECT s.section, s.title, s.source, $1, s.id, s.content_version, 1, s.origin_meta
     FROM specs s WHERE s.id = $2
     RETURNING id`,
    [projectId, masterId]
  );
  const row = res.rows[0];
  if (!row) throw new DatabaseError(`cloneSpecRow: master spec ${masterId} vanished`);
  return row.id;
}

/** Set-based paragraph clone: UUID-map CTE, parent_id remapped via self-join,
 *  origin_paragraph_id records the mapping. Lossless by construction. */
async function cloneParagraphs(
  masterId: string,
  cloneId: string,
  client: PoolClient
): Promise<void> {
  await client.query(
    `WITH map AS (
       SELECT id AS old_id, gen_random_uuid() AS new_id
       FROM paragraphs WHERE spec_id = $1
     )
     INSERT INTO paragraphs
       (id, spec_id, parent_id, node_type, text, position, vanish, revit_param,
        base_version, conflicts, origin_paragraph_id)
     SELECT m.new_id, $2, pm.new_id, p.node_type, p.text, p.position, p.vanish,
            p.revit_param, p.base_version, p.conflicts, p.id
     FROM paragraphs p
     JOIN map m ON m.old_id = p.id
     LEFT JOIN map pm ON pm.old_id = p.parent_id`,
    [masterId, cloneId]
  );
}

/** Clone outgoing refs. origin_paragraph_id doubles as the paragraph UUID map.
 *  Target resolution is project-scope first: a section already among this
 *  project's specs resolves; otherwise NULL + is_broken (repaired when the
 *  section is later added). Cross-spec paragraph targets cannot be mapped into
 *  another spec's clone → NULL via the scoped tp join. */
async function cloneRefs(
  projectId: string,
  masterId: string,
  cloneId: string,
  client: PoolClient
): Promise<void> {
  await client.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section,
        target_spec_id, target_paragraph_id, standard_code, reference_text, is_broken)
     SELECT $3, sp.id, sr.target_type, sr.target_spec_section,
            tgt.id, tp.id, sr.standard_code, sr.reference_text,
            (sr.target_type = 'section' AND tgt.id IS NULL)
     FROM spec_references sr
     JOIN paragraphs sp ON sp.spec_id = $3 AND sp.origin_paragraph_id = sr.source_paragraph_id
     LEFT JOIN paragraphs tp ON tp.spec_id = $3 AND tp.origin_paragraph_id = sr.target_paragraph_id
     LEFT JOIN specs tgt ON tgt.project_id = $1 AND tgt.section = sr.target_spec_section
     WHERE sr.source_spec_id = $2`,
    [projectId, masterId, cloneId]
  );
}

/** TOC row at max+1, plus project-scoped repair of broken refs that were
 *  waiting for this section (same repair CTE addSpecToProject used). */
async function insertTocEntry(
  projectId: string,
  cloneId: string,
  section: string,
  client: PoolClient
): Promise<number> {
  const res = await client.query<{ position: number }>(
    `WITH inserted AS (
       INSERT INTO project_specs (project_id, spec_id, position)
       SELECT $1, $2, COALESCE(MAX(position), 0) + 1
       FROM project_specs WHERE project_id = $1
       RETURNING position
     ),
     repaired AS (
       UPDATE spec_references sr
       SET target_spec_id = $2, is_broken = false
       FROM project_specs ps
       WHERE sr.target_spec_section = $3
         AND sr.is_broken = true
         AND sr.source_spec_id = ps.spec_id
         AND ps.project_id = $1
         AND EXISTS (SELECT 1 FROM inserted)
     )
     SELECT position FROM inserted`,
    [projectId, cloneId, section]
  );
  const row = res.rows[0];
  if (!row) throw new DatabaseError('insertTocEntry: no row returned after insert');
  return row.position;
}

/** Resolve a section through the project's source list and clone the winning
 *  master into a project-owned copy. One transaction; all-or-nothing. */
export async function addSectionToProject(
  projectId: string,
  section: string,
  db: Pool = pool
): Promise<AddSectionResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { master, shadowed } = await resolveSection(projectId, section, client);
    const cloneId = await cloneSpecRow(projectId, master.spec_id, client);
    await cloneParagraphs(master.spec_id, cloneId, client);
    await cloneRefs(projectId, master.spec_id, cloneId, client);
    const position = await insertTocEntry(projectId, cloneId, section, client);
    await client.query('COMMIT');
    logger.info(
      { projectId, section, cloneId, masterId: master.spec_id },
      'addSectionToProject: section cloned into project'
    );
    return {
      specId: cloneId,
      section,
      position,
      source: { libraryId: master.library_id, name: master.name },
      ...(shadowed.length > 0 ? { shadowed } : {}),
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `addSectionToProject: failed for section ${section} in project ${projectId}`,
      { cause: err }
    );
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Export from the barrel**

In `src/db/index.ts`, after the projects exports block, add:

```typescript
export {
  addSectionToProject,
  ProjectNotFoundError,
  SectionUnresolvedError,
} from './queries/derive.js';
export type { AddSectionResult, SourceLibraryRef } from './queries/derive.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration -- derive
```

Expected: PASS (all derive tests green).

- [ ] **Step 6: Lint, format, full unit suite, commit**

```bash
pnpm format && pnpm lint && pnpm test
git add src/db/queries/derive.ts src/db/queries/derive.integration.test.ts src/db/index.ts
git commit -m "feat(db): addSectionToProject — project_sources resolution + SQL set-based clone

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `derive.ts` — `removeSectionFromProject` (block-if-edited + force)

**Files:**
- Modify: `src/db/queries/derive.ts`
- Modify: `src/db/queries/derive.integration.test.ts`
- Modify: `src/db/index.ts`

- [ ] **Step 1: Write the failing integration tests**

Append to `src/db/queries/derive.integration.test.ts` (import `removeSectionFromProject` from `./derive.js` at the top):

```typescript
describe('removeSectionFromProject', () => {
  it('clean clone (content_version = 1) deletes freely: spec, paragraphs, TOC row gone; master intact', async () => {
    const projectId = await newProject([companyLib]);
    const { specId } = await addSectionToProject(projectId, '03 30 00', pool);
    const outcome = await removeSectionFromProject(projectId, specId, false, pool);
    expect(outcome).toBe('removed');
    const counts = await pool.query<{ specs: string; paras: string; toc: string }>(
      `SELECT
         (SELECT COUNT(*) FROM specs WHERE id = $1) AS specs,
         (SELECT COUNT(*) FROM paragraphs WHERE spec_id = $1) AS paras,
         (SELECT COUNT(*) FROM project_specs WHERE spec_id = $1) AS toc`,
      [specId]
    );
    expect(counts.rows[0]).toEqual({ specs: '0', paras: '0', toc: '0' });
    const master = await pool.query(`SELECT 1 FROM specs WHERE id = $1`, [masterId]);
    expect(master.rowCount).toBe(1);
  });

  it('edited clone (content_version > 1) → blocked without force; force=true deletes', async () => {
    const projectId = await newProject([companyLib]);
    const { specId } = await addSectionToProject(projectId, '03 30 00', pool);
    await pool.query(`UPDATE specs SET content_version = 2 WHERE id = $1`, [specId]);
    expect(await removeSectionFromProject(projectId, specId, false, pool)).toBe('edited');
    // blocked removal left everything in place
    const still = await pool.query(`SELECT 1 FROM project_specs WHERE spec_id = $1`, [specId]);
    expect(still.rowCount).toBe(1);
    expect(await removeSectionFromProject(projectId, specId, true, pool)).toBe('removed');
  });

  it('spec not owned by this project (a master id) → not-found', async () => {
    const projectId = await newProject([companyLib]);
    expect(await removeSectionFromProject(projectId, masterId, false, pool)).toBe('not-found');
  });

  it('broken-ref marking for other project specs that referenced the removed clone is preserved', async () => {
    const projectId = await newProject([companyLib]);
    const a = await addSectionToProject(projectId, '03 30 00', pool); // refs 09 91 00
    const b = await addSectionToProject(projectId, '09 91 00', pool);
    const outcome = await removeSectionFromProject(projectId, b.specId, false, pool);
    expect(outcome).toBe('removed');
    const ref = await pool.query<{ is_broken: boolean; target_spec_id: string | null }>(
      `SELECT is_broken, target_spec_id FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'section'`,
      [a.specId]
    );
    expect(ref.rows[0]?.is_broken).toBe(true);
    expect(ref.rows[0]?.target_spec_id).toBeNull(); // FK SET NULL on spec delete
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration -- derive
```

Expected: FAIL — `removeSectionFromProject` is not exported.

- [ ] **Step 3: Implement in `derive.ts`**

Append:

```typescript
export type RemoveSectionOutcome = 'removed' | 'not-found' | 'edited';

/** Delete a project-owned clone (TOC row, refs, paragraph tree). Edited clones
 *  (content_version > 1) are blocked unless force — the caller maps 'edited'
 *  to 409 and surfaces ?force=true. Incoming refs from the project's other
 *  specs are marked broken first (target_spec_id then SET NULL by FK). */
export async function removeSectionFromProject(
  projectId: string,
  specId: string,
  force: boolean,
  db: Pool = pool
): Promise<RemoveSectionOutcome> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $2 AND project_id = $1 FOR UPDATE`,
      [projectId, specId]
    );
    const row = owned.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return 'not-found';
    }
    if (row.content_version > 1 && !force) {
      await client.query('ROLLBACK');
      return 'edited';
    }
    await client.query(
      `UPDATE spec_references sr SET is_broken = true
       FROM project_specs ps
       WHERE sr.target_spec_id = $2
         AND sr.source_spec_id = ps.spec_id
         AND ps.project_id = $1
         AND sr.source_spec_id <> $2`,
      [projectId, specId]
    );
    await client.query(`DELETE FROM project_specs WHERE project_id = $1 AND spec_id = $2`, [
      projectId,
      specId,
    ]);
    await client.query(`DELETE FROM specs WHERE id = $1`, [specId]);
    await client.query('COMMIT');
    logger.info({ projectId, specId, force }, 'removeSectionFromProject: clone deleted');
    return 'removed';
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    throw new DatabaseError(`removeSectionFromProject: failed for spec ${specId}`, { cause: err });
  } finally {
    client.release();
  }
}
```

Add to `src/db/index.ts` derive export block: `removeSectionFromProject` (value) and `RemoveSectionOutcome` (type).

- [ ] **Step 4: Run tests to verify pass**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration -- derive
```

Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm format && pnpm lint && pnpm test
git add src/db/queries/derive.ts src/db/queries/derive.integration.test.ts src/db/index.ts
git commit -m "feat(db): removeSectionFromProject — block edited clones, force override

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `POST /projects` requires sources; `GET /projects/:id` returns them

**Files:**
- Modify: `src/db/queries/projects.ts` (createProject, findProjectById, new InvalidSourceLibraryError + ProjectSource)
- Modify: `src/ast/schemas.ts` + `src/ast/index.ts` (CreateProjectBodySchema)
- Modify: `src/api/projects.ts` (createProjectHandler 422 mapping)
- Modify: `src/db/index.ts`
- Modify: `src/db/queries/projects.test.ts`, `src/api/projects.test.ts` (unit)
- Modify: `src/api/projects.integration.test.ts` (POST /projects + GET blocks only — the TOC-flow rewrite is Task 6)

- [ ] **Step 1: Write/adjust the failing unit tests**

In `src/db/queries/projects.test.ts`, replace the `createProject` describe with:

```typescript
describe('createProject', () => {
  it('validates source tiers, inserts project + sources, returns sources in priority order', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({
        rows: [
          { id: 'lib-client', name: 'Client M', tier: 'client' },
          { id: 'lib-co', name: 'Co M', tier: 'company' },
        ],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'proj-1', name: 'Test Project', description: null }],
        rowCount: 1,
      } as never);
    const { createProject } = await import('./projects.js');
    const result = await createProject(
      { name: 'Test Project', sourceLibraryIds: ['lib-client', 'lib-co'] },
      pool
    );
    expect(result.projectId).toBe('proj-1');
    expect(result.sources).toEqual([
      { libraryId: 'lib-client', name: 'Client M', tier: 'client', priority: 1 },
      { libraryId: 'lib-co', name: 'Co M', tier: 'company', priority: 2 },
    ]);
  });

  it('rejects a reference-tier source library (ADR-015 D3)', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 'lib-ref', name: 'UFGS Reference', tier: 'reference' }],
      rowCount: 1,
    } as never);
    const { createProject, InvalidSourceLibraryError } = await import('./projects.js');
    await expect(
      createProject({ name: 'x', sourceLibraryIds: ['lib-ref'] }, pool)
    ).rejects.toBeInstanceOf(InvalidSourceLibraryError);
  });

  it('rejects an unknown source library id', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { createProject, InvalidSourceLibraryError } = await import('./projects.js');
    await expect(
      createProject({ name: 'x', sourceLibraryIds: ['lib-missing'] }, pool)
    ).rejects.toBeInstanceOf(InvalidSourceLibraryError);
  });

  it('throws DatabaseError on query failure', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { createProject } = await import('./projects.js');
    await expect(
      createProject({ name: 'x', sourceLibraryIds: ['lib-1'] }, pool)
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
```

In the same file, update `findProjectById` "returns ProjectWithToc" test: implementation will run a THIRD query (sources) after project + toc — add a third `.mockResolvedValueOnce`:

```typescript
      .mockResolvedValueOnce({
        rows: [{ library_id: 'lib-1', name: 'Co M', tier: 'company', priority: 1 }],
        rowCount: 1,
      } as never);
```

and assert `expect(result?.sources).toEqual([{ libraryId: 'lib-1', name: 'Co M', tier: 'company', priority: 1 }]);`

In `src/api/projects.test.ts`:
- Add to the `vi.mock('../db/index.js', ...)` factory: `InvalidSourceLibraryError: class InvalidSourceLibraryError extends Error {},` (keep the existing mocked names for now — handlers for specs flow change in Task 6).
- Update `createProjectHandler` 201 test: body `{ name: 'Test', sourceLibraryIds: ['lib-1'] }`, mocked resolve value gains `sources: []`.
- Add a 422 test:

```typescript
  it('returns 422 when a source library is invalid', async () => {
    const { createProject, InvalidSourceLibraryError } = await import('../db/index.js');
    vi.mocked(createProject).mockRejectedValueOnce(
      new (InvalidSourceLibraryError as new (m: string) => Error)('bad tier')
    );
    const { createProjectHandler } = await import('./projects.js');
    const req = { body: { name: 'Test', sourceLibraryIds: ['lib-ref'] } } as unknown as Request;
    const res = makeRes();
    await createProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(422);
  });
```

Also add unit tests for the new schema in `src/ast/schemas.test.ts` (find the existing describe pattern in that file and append):

```typescript
describe('CreateProjectBodySchema (issue #94)', () => {
  const valid = {
    name: 'P',
    sourceLibraryIds: ['8f14e45f-ceea-4e07-8c65-3f0f1c6e1a01'],
  };
  it('accepts name + sourceLibraryIds', () => {
    expect(CreateProjectBodySchema.safeParse(valid).success).toBe(true);
  });
  it('rejects missing sourceLibraryIds', () => {
    expect(CreateProjectBodySchema.safeParse({ name: 'P' }).success).toBe(false);
  });
  it('rejects empty sourceLibraryIds', () => {
    expect(
      CreateProjectBodySchema.safeParse({ name: 'P', sourceLibraryIds: [] }).success
    ).toBe(false);
  });
  it('rejects duplicate sourceLibraryIds', () => {
    expect(
      CreateProjectBodySchema.safeParse({
        name: 'P',
        sourceLibraryIds: [valid.sourceLibraryIds[0], valid.sourceLibraryIds[0]],
      }).success
    ).toBe(false);
  });
  it('rejects non-uuid entries', () => {
    expect(
      CreateProjectBodySchema.safeParse({ name: 'P', sourceLibraryIds: ['nope'] }).success
    ).toBe(false);
  });
});
```

(Import `CreateProjectBodySchema` at the top of `schemas.test.ts` if not already imported.)

- [ ] **Step 2: Run unit tests to verify failure**

```bash
pnpm test
```

Expected: FAIL — `sourceLibraryIds` unknown on CreateProjectInput, `InvalidSourceLibraryError` not exported, schema rejects nothing yet.

- [ ] **Step 3: Implement**

`src/ast/schemas.ts` — replace `CreateProjectBodySchema`:

```typescript
export const CreateProjectBodySchema = z.object({
  name: z.string().check(z.minLength(1)),
  description: z.string().check(z.minLength(1)).exactOptional(),
  // Ordered source list (priority = array order, 1-based). Required, min 1 —
  // section-resolution is the only way to add specs, so a sourceless project
  // would be a dead end (design doc #94).
  sourceLibraryIds: z
    .array(z.uuid())
    .check(z.minLength(1))
    .check((ctx) => {
      if (new Set(ctx.value).size !== ctx.value.length) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'sourceLibraryIds must not contain duplicates',
        });
      }
    }),
});
```

`src/db/queries/projects.ts` — add imports/types and rewrite createProject + findProjectById:

```typescript
import type { LibraryTier } from './libraries.js';

/** A project source library is invalid (unknown id or non-master tier) → 422. */
export class InvalidSourceLibraryError extends DatabaseError {}

export interface ProjectSource {
  readonly libraryId: string;
  readonly name: string;
  readonly tier: LibraryTier;
  readonly priority: number;
}

interface SourceLibRow {
  readonly id: string;
  readonly name: string;
  readonly tier: LibraryTier;
}

interface ProjectSourceRow {
  readonly library_id: string;
  readonly name: string;
  readonly tier: LibraryTier;
  readonly priority: number;
}
```

Extend the result interfaces:

```typescript
export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly sources: readonly ProjectSource[];
}

export interface ProjectWithToc {
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly sources: readonly ProjectSource[];
  readonly toc: readonly ProjectTocEntry[];
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly sourceLibraryIds: readonly string[];
}
```

```typescript
/** Sources must be company or client masters (ADR-015 D3) — reference-tier
 *  content must first be derived into a company master. Returned in input
 *  order (= priority order). */
async function validateSourceLibraries(
  ids: readonly string[],
  pool: Queryable
): Promise<readonly SourceLibRow[]> {
  const res = await pool.query<SourceLibRow>(
    `SELECT id, name, tier FROM libraries WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  const byId = new Map(res.rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const lib = byId.get(id);
    if (!lib) {
      throw new InvalidSourceLibraryError(`createProject: source library ${id} not found`);
    }
    if (lib.tier !== 'company' && lib.tier !== 'client') {
      throw new InvalidSourceLibraryError(
        `createProject: library "${lib.name}" is ${lib.tier}-tier — project sources must be company or client masters`
      );
    }
    return lib;
  });
}

export async function createProject(
  input: CreateProjectInput,
  pool: Queryable
): Promise<ProjectSummary> {
  try {
    const libs = await validateSourceLibraries(input.sourceLibraryIds, pool);
    const result = await pool.query<ProjectRow>(
      `WITH proj AS (
         INSERT INTO projects (name, description) VALUES ($1, $2)
         RETURNING id, name, description
       ),
       src AS (
         INSERT INTO project_sources (project_id, library_id, priority)
         SELECT proj.id, u.lib_id, u.ord::int
         FROM proj, unnest($3::uuid[]) WITH ORDINALITY AS u(lib_id, ord)
       )
       SELECT id, name, description FROM proj`,
      [input.name, input.description ?? null, input.sourceLibraryIds]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createProject: no row returned after insert');
    const sources = libs.map((lib, i) => ({
      libraryId: lib.id,
      name: lib.name,
      tier: lib.tier,
      priority: i + 1,
    }));
    return { projectId: row.id, name: row.name, description: row.description, sources };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('createProject: insert failed', { cause: err });
  }
}
```

(`InvalidSourceLibraryError extends DatabaseError`, so the `instanceof DatabaseError` rethrow guard preserves it.)

`findProjectById`: after the toc query (inside the same try), add:

```typescript
    const srcRes = await pool.query<ProjectSourceRow>(
      `SELECT ps.library_id, l.name, l.tier, ps.priority
       FROM project_sources ps
       JOIN libraries l ON l.id = ps.library_id
       WHERE ps.project_id = $1
       ORDER BY ps.priority`,
      [id]
    );
```

and include in the returned object:

```typescript
      sources: srcRes.rows.map((row) => ({
        libraryId: row.library_id,
        name: row.name,
        tier: row.tier,
        priority: row.priority,
      })),
```

(If the function body now exceeds 50 lines, extract the toc+sources mapping into a small helper `loadProjectDetail` in the same file.)

`src/api/projects.ts` — `createProjectHandler` catch gains, before the generic 500:

```typescript
    if (err instanceof InvalidSourceLibraryError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
```

(import `InvalidSourceLibraryError` from `'../db/index.js'`).

`src/db/index.ts` — add to the projects export block: `InvalidSourceLibraryError` (value) and `ProjectSource` (type).

- [ ] **Step 4: Update the integration test's POST /projects block**

In `src/api/projects.integration.test.ts`: the `POST /projects` describe must send `sourceLibraryIds`. Add a helper + library lookup at the top:

```typescript
async function getLibraryId(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM libraries WHERE name = $1`, [name]);
  if (!r.rows[0]) throw new Error(`library ${name} missing — run migrations`);
  return r.rows[0].id;
}
```

In the `POST /projects` describe, resolve `companyId = await getLibraryId('Default Company Master')` and `ufgsId = await getLibraryId('UFGS Reference')` in a `beforeAll`, then:
- 201 test body: `{ name: 'New Project', sourceLibraryIds: [companyId] }`; additionally assert `data['sources']` is an array with one entry whose `libraryId` is `companyId`.
- Keep the 422 missing-name / empty-name tests but include `sourceLibraryIds: [companyId]` in their bodies so they fail on name alone.
- Add: 422 when `sourceLibraryIds` missing (`{ name: 'X' }`); 422 when reference-tier (`{ name: 'X', sourceLibraryIds: [ufgsId] }`); 404-or-422 unknown library (`{ name: 'X', sourceLibraryIds: ['00000000-0000-0000-0000-000000000000'] }` → expect 422).
- In `GET /projects/:id` describe: the seeded raw-SQL project has no sources → assert `data['sources']` equals `[]` (proves the field is present).

Do NOT touch the TOC add/remove describes yet — they still use specId and still pass (Task 6 rewrites them).

- [ ] **Step 5: Run everything**

```bash
pnpm format && pnpm lint && pnpm test
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A src/
git commit -m "feat(api): POST /projects requires ordered source list — company/client tiers only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Section-based add + force-guarded remove at the API; delete the alias path

**Files:**
- Modify: `src/api/projects.ts` (addSectionToProjectHandler, removeSectionFromProjectHandler)
- Modify: `src/api/router.ts`
- Modify: `src/ast/schemas.ts` + `src/ast/index.ts` (AddSectionToProjectBodySchema replaces AddSpecToProjectBodySchema)
- Modify: `src/db/queries/projects.ts` (DELETE `addSpecToProject` + `removeSpecFromProject` + `AddSpecResult`)
- Modify: `src/db/index.ts` (drop removed exports)
- Modify: `src/db/queries/projects.test.ts`, `src/api/projects.test.ts`
- Rewrite: `src/api/projects.integration.test.ts` TOC-flow describes

- [ ] **Step 1: Write the failing tests**

`src/ast/schemas.ts` — schema (write test first in `schemas.test.ts`):

```typescript
describe('AddSectionToProjectBodySchema (issue #94)', () => {
  it('accepts a canonical section number', () => {
    expect(AddSectionToProjectBodySchema.safeParse({ section: '03 30 00' }).success).toBe(true);
  });
  it('rejects a malformed section number', () => {
    expect(AddSectionToProjectBodySchema.safeParse({ section: '3 30 00' }).success).toBe(false);
  });
  it('rejects a specId body (old contract)', () => {
    expect(
      AddSectionToProjectBodySchema.safeParse({
        specId: '8f14e45f-ceea-4e07-8c65-3f0f1c6e1a01',
      }).success
    ).toBe(false);
  });
});
```

`src/api/projects.test.ts` — replace the `addSpecToProjectHandler` and `removeSpecFromProjectHandler` describes:

```typescript
describe('addSectionToProjectHandler', () => {
  it('returns 201 with AddSectionResult on success', async () => {
    const { addSectionToProject } = await import('../db/index.js');
    vi.mocked(addSectionToProject).mockResolvedValueOnce({
      specId: 'clone-1',
      section: '03 30 00',
      position: 1,
      source: { libraryId: 'lib-1', name: 'Co M' },
    });
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' }, body: { section: '03 30 00' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((body['data'] as Record<string, unknown>)['specId']).toBe('clone-1');
  });

  it('returns 404 for unknown project (ProjectNotFoundError)', async () => {
    const { addSectionToProject, ProjectNotFoundError } = await import('../db/index.js');
    vi.mocked(addSectionToProject).mockRejectedValueOnce(
      new (ProjectNotFoundError as new (m: string) => Error)('nope')
    );
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' }, body: { section: '03 30 00' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 422 when no source holds the section (SectionUnresolvedError)', async () => {
    const { addSectionToProject, SectionUnresolvedError } = await import('../db/index.js');
    vi.mocked(addSectionToProject).mockRejectedValueOnce(
      new (SectionUnresolvedError as new (m: string) => Error)('unresolved')
    );
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' }, body: { section: '99 99 99' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('returns 409 on duplicate section (pg 23505)', async () => {
    const { addSectionToProject, DatabaseError } = await import('../db/index.js');
    const cause = Object.assign(new Error('unique'), { code: '23505' });
    vi.mocked(addSectionToProject).mockRejectedValueOnce(
      new (DatabaseError as new (m: string, o?: ErrorOptions) => Error)('dup', { cause })
    );
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' }, body: { section: '03 30 00' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toBe('section already in project');
  });

  it('returns 400 when id param missing', async () => {
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: {}, body: { section: '03 30 00' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('removeSectionFromProjectHandler', () => {
  it('returns 200 on removed', async () => {
    const { removeSectionFromProject } = await import('../db/index.js');
    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('removed');
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1', specId: 's1' }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(removeSectionFromProject)).toHaveBeenCalledWith('p1', 's1', false, {});
  });

  it('returns 404 on not-found', async () => {
    const { removeSectionFromProject } = await import('../db/index.js');
    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('not-found');
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1', specId: 's1' }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 409 on edited without force; force=true is forwarded', async () => {
    const { removeSectionFromProject } = await import('../db/index.js');
    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('edited');
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1', specId: 's1' }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(409);

    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('removed');
    const req2 = {
      params: { id: 'p1', specId: 's1' },
      query: { force: 'true' },
    } as unknown as Request;
    const res2 = makeRes();
    await removeSectionFromProjectHandler(req2, res2 as unknown as Response);
    expect(vi.mocked(removeSectionFromProject)).toHaveBeenLastCalledWith('p1', 's1', true, {});
  });

  it('returns 400 when specId param missing', async () => {
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
```

Update the `vi.mock('../db/index.js', ...)` factory in this file: remove `addSpecToProject`/`removeSpecFromProject`, add:

```typescript
  addSectionToProject: vi.fn(),
  removeSectionFromProject: vi.fn(),
  ProjectNotFoundError: class ProjectNotFoundError extends Error {},
  SectionUnresolvedError: class SectionUnresolvedError extends Error {},
```

(`InvalidSourceLibraryError` already added in Task 5. The `pool: {}` mock is what makes `toHaveBeenCalledWith('p1', 's1', false, {})` assert the pool pass-through.)

Rewrite the TOC-flow describes of `src/api/projects.integration.test.ts` (`POST /projects/:id/specs`, `DELETE from TOC`, `re-add to TOC`, `DELETE not found`). New flow — replace those describes wholesale with:

```typescript
describe('POST /projects/:id/specs (section-based copy-on-derive)', () => {
  let projectId: string;
  let cloneA: string;

  beforeAll(async () => {
    const res = await postJSON('/projects', {
      name: `Derive API ${Date.now()}`,
      sourceLibraryIds: [companyLibId],
    });
    const body = (await res.json()) as Record<string, unknown>;
    projectId = ((body['data'] as Record<string, unknown>)['projectId'] as string);
    apiProjects.push(projectId);
  });

  it('adds a section: 201 with clone specId (not the master), source, position', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    expect(res.status).toBe(201);
    const d = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(d['specId']).not.toBe(specA);
    expect(d['section']).toBe('03 30 00');
    expect(d['position']).toBe(1);
    expect((d['source'] as Record<string, unknown>)['libraryId']).toBe(companyLibId);
    cloneA = d['specId'] as string;
  });

  it('409 on duplicate section', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    expect(res.status).toBe(409);
  });

  it('422 when no source holds the section', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '99 99 99' });
    expect(res.status).toBe(422);
  });

  it('422 for malformed section body', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { specId: specA });
    expect(res.status).toBe(422);
  });

  it('404 for unknown project', async () => {
    const res = await postJSON(`/projects/00000000-0000-0000-0000-000000000000/specs`, {
      section: '03 30 00',
    });
    expect(res.status).toBe(404);
  });

  it('DELETE clean clone returns 200 and deletes the copy, master survives', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/specs/${cloneA}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const gone = await pool.query('SELECT 1 FROM specs WHERE id = $1', [cloneA]);
    expect(gone.rowCount).toBe(0);
    const master = await pool.query('SELECT 1 FROM specs WHERE id = $1', [specA]);
    expect(master.rowCount).toBe(1);
  });

  it('DELETE edited clone → 409; ?force=true → 200', async () => {
    const add = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    const d = ((await add.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    const cloneId = d['specId'] as string;
    await pool.query('UPDATE specs SET content_version = 2 WHERE id = $1', [cloneId]);
    const blocked = await fetch(`${baseUrl}/projects/${projectId}/specs/${cloneId}`, {
      method: 'DELETE',
    });
    expect(blocked.status).toBe(409);
    const forced = await fetch(
      `${baseUrl}/projects/${projectId}/specs/${cloneId}?force=true`,
      { method: 'DELETE' }
    );
    expect(forced.status).toBe(200);
  });

  it('DELETE returns 404 when spec not owned by project', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/specs/${specA}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});
```

Supporting changes in the same file:
- `insertSpec` helper: insert into the **Default Company Master** library instead of UFGS Reference (sources must be company-tier):

```typescript
async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title]
  );
  const row = r.rows[0];
  if (!row) throw new Error(`failed to insert spec ${section}`);
  return row.id;
}
```

- Module-level: `let companyLibId: string;` and `const apiProjects: string[] = [];` — set `companyLibId = await getLibraryId('Default Company Master')` in the outer `beforeAll`; in `afterAll`, clean clones then projects:

```typescript
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [apiProjects]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [apiProjects]);
```

(Delete order note: clones must be deleted only after their `project_specs` rows are gone — `DELETE FROM projects` cascades `project_specs`, so delete projects FIRST, then clones: swap the two statements above accordingly: projects first, then `DELETE FROM specs WHERE project_id = ANY($1)`.)
- The old `DELETE from TOC (broken ref cascade)` and `re-add to TOC` describes tested master-aliasing semantics that no longer exist at the API; their DB-grain equivalents are covered in `derive.integration.test.ts` (Task 3 ref-repair + Task 4 broken-ref-preserved tests). DELETE those describes. Keep the existing beforeAll fixture (specA/specB + refs) — `GET /projects/:id` and broken-refs tests still use it; the raw-SQL `project_specs` insert in beforeAll keeps working because `specB`'s join rows are still valid (masters can sit in TOCs only until migration 019 backfills them — these test projects are created and destroyed inside the suite, which is fine: the runtime API path never creates new alias rows).

Wait — Task 8's migration 019 will run AFTER this suite exists; CI order is migrate → test. The raw-SQL aliased fixture is created at test time (post-migration), so the backfill never sees it. That is acceptable: the fixture only feeds `GET /projects/:id` TOC-shape and broken-refs read paths, which don't care who owns the spec.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test
```

Expected: FAIL — `AddSectionToProjectBodySchema` doesn't exist, handlers don't exist.

- [ ] **Step 3: Implement**

`src/ast/schemas.ts` — replace `AddSpecToProjectBodySchema`:

```typescript
export const AddSectionToProjectBodySchema = z.object({
  // Canonical expanded-shape section number (lib/section-number.ts, ADR-020).
  section: SectionNumberSchema,
});

export type AddSectionToProjectBody = z.infer<typeof AddSectionToProjectBodySchema>;
```

`src/ast/index.ts` — swap `AddSpecToProjectBodySchema` → `AddSectionToProjectBodySchema` and `AddSpecToProjectBody` → `AddSectionToProjectBody`.

`src/api/projects.ts` — replace `addSpecToProjectHandler` and `removeSpecFromProjectHandler`:

```typescript
export async function addSectionToProjectHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'];
  if (!id || typeof id !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  try {
    const body = req.body as AddSectionToProjectBody;
    const result = await addSectionToProject(id, body.section, pool);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    if (err instanceof SectionUnresolvedError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    const mapped = pgErrorToHttp(err, { '23505': 'section already in project' });
    if (mapped) {
      res.status(mapped.status).json({ success: false, error: mapped.error });
      return;
    }
    logger.error({ err }, 'add section to project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function removeSectionFromProjectHandler(req: Request, res: Response): Promise<void> {
  const projectId = req.params['id'];
  const specId = req.params['specId'];
  if (!projectId || typeof projectId !== 'string') {
    res.status(400).json({ success: false, error: 'missing project id' });
    return;
  }
  if (!specId || typeof specId !== 'string') {
    res.status(400).json({ success: false, error: 'missing spec id' });
    return;
  }
  const force = req.query['force'] === 'true';
  try {
    const outcome = await removeSectionFromProject(projectId, specId, force, pool);
    if (outcome === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not in project' });
      return;
    }
    if (outcome === 'edited') {
      res.status(409).json({
        success: false,
        error: 'section has project edits — repeat with ?force=true to delete them',
      });
      return;
    }
    res.status(200).json({ success: true, data: { projectId, specId } });
  } catch (err) {
    logger.error({ err }, 'remove section from project failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

Update this file's imports: drop `addSpecToProject`, `removeSpecFromProject`, `AddSpecToProjectBody`; add `addSectionToProject`, `removeSectionFromProject`, `ProjectNotFoundError`, `SectionUnresolvedError` (from `'../db/index.js'`) and `AddSectionToProjectBody` (from `'../ast/index.js'`).

`src/api/router.ts` — swap imports and:

```typescript
router.post(
  '/projects/:id/specs',
  validateBody(AddSectionToProjectBodySchema),
  addSectionToProjectHandler
);
router.delete('/projects/:id/specs/:specId', removeSectionFromProjectHandler);
```

`src/db/queries/projects.ts` — DELETE `addSpecToProject`, `removeSpecFromProject`, and `AddSpecResult`. Delete their describes from `src/db/queries/projects.test.ts`.

`src/db/index.ts` — remove `addSpecToProject`, `removeSpecFromProject` from the value exports and `AddSpecResult` from the type exports.

- [ ] **Step 4: Run everything**

```bash
pnpm format && pnpm lint && pnpm test
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration
```

Expected: all green. `grep -rn "addSpecToProject" src/` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "feat(api): copy-on-derive TOC — section-based add, force-guarded remove

POST /projects/:id/specs takes { section } and clones through
project_sources resolution; DELETE blocks edited copies without
?force=true. The alias path (addSpecToProject by specId) is removed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `getBrokenRefs` → `availableFrom` advisory

**Files:**
- Modify: `src/db/queries/projects.ts`, `src/db/queries/projects.test.ts`
- Modify: `src/api/projects.integration.test.ts` (broken-refs describe)
- Modify: `src/db/index.ts` only if types change shape (BrokenRef stays exported)

- [ ] **Step 1: Write the failing tests**

Unit (`src/db/queries/projects.test.ts`) — in the `getBrokenRefs` describe, change the mapped-row test to include the new column and assertion:

```typescript
  it('returns mapped BrokenRef array with availableFrom advisory', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        {
          id: 'ref-1',
          source_spec_id: 'spec-1',
          source_spec_section: '03 30 00',
          target_spec_section: '09 91 00',
          reference_text: 'See Section 09 91 00',
          available_from: [{ libraryId: 'lib-1', name: 'Co M' }],
        },
        {
          id: 'ref-2',
          source_spec_id: 'spec-1',
          source_spec_section: '03 30 00',
          target_spec_section: '99 99 99',
          reference_text: 'See Section 99 99 99',
          available_from: null,
        },
      ],
      rowCount: 2,
    } as never);
    const { getBrokenRefs } = await import('./projects.js');
    const result = await getBrokenRefs('proj-1', pool);
    expect(result[0]?.availableFrom).toEqual([{ libraryId: 'lib-1', name: 'Co M' }]);
    expect(result[1]?.availableFrom).toEqual([]);
  });
```

Integration (`src/api/projects.integration.test.ts`) — add a describe (uses the derive flow):

```typescript
describe('GET /projects/:id/references/broken — availableFrom advisory', () => {
  it('broken ref lists the source libraries that hold the missing section', async () => {
    const created = await postJSON('/projects', {
      name: `Advisory ${Date.now()}`,
      sourceLibraryIds: [companyLibId],
    });
    const pid = (((await created.json()) as Record<string, unknown>)['data'] as Record<
      string,
      unknown
    >)['projectId'] as string;
    apiProjects.push(pid);
    // 03 30 00's master ref points at 09 91 00, which the company master holds
    await postJSON(`/projects/${pid}/specs`, { section: '03 30 00' });
    const res = await fetch(`${baseUrl}/projects/${pid}/references/broken`);
    expect(res.status).toBe(200);
    const refs = (((await res.json()) as Record<string, unknown>)['data'] as Array<
      Record<string, unknown>
    >);
    const ref = refs.find((r) => r['targetSpecSection'] === '09 91 00');
    expect(ref).toBeDefined();
    expect(ref?.['availableFrom']).toEqual([
      expect.objectContaining({ libraryId: companyLibId }),
    ]);
  });
});
```

**Fixture prerequisite:** this needs a master ref from `specA` (03 30 00) to section `09 91 00` — the existing beforeAll already inserts exactly that (`insertRef(specA, paraAId, '09 91 00', specB, ...)`). No change needed.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test
```

Expected: FAIL — `availableFrom` undefined.

- [ ] **Step 3: Implement**

`src/db/queries/projects.ts`:

```typescript
interface BrokenRefRow {
  readonly id: string;
  readonly source_spec_id: string;
  readonly source_spec_section: string;
  readonly target_spec_section: string | null;
  readonly reference_text: string;
  readonly available_from: readonly { libraryId: string; name: string }[] | null;
}

export interface BrokenRef {
  readonly refId: string;
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly targetSpecSection: string | null;
  readonly referenceText: string;
  /** Project source libraries that hold the missing target section — the
   *  actionable "add this section" advisory (design doc #94). Priority order. */
  readonly availableFrom: readonly { libraryId: string; name: string }[];
}
```

Query becomes:

```sql
SELECT sr.id, sr.source_spec_id, s.section AS source_spec_section,
       sr.target_spec_section, sr.reference_text,
       (SELECT json_agg(json_build_object('libraryId', l.id, 'name', l.name)
                        ORDER BY pso.priority)
        FROM project_sources pso
        JOIN libraries l ON l.id = pso.library_id
        WHERE pso.project_id = $1
          AND EXISTS (SELECT 1 FROM specs ms
                      WHERE ms.library_id = pso.library_id
                        AND ms.section = sr.target_spec_section)) AS available_from
FROM spec_references sr
JOIN specs s ON s.id = sr.source_spec_id
JOIN project_specs ps ON ps.spec_id = sr.source_spec_id AND ps.project_id = $1
WHERE sr.is_broken = true
```

Mapping adds: `availableFrom: row.available_from ?? [],`

- [ ] **Step 4: Run everything; commit**

```bash
pnpm format && pnpm lint && pnpm test
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration
git add -A src/
git commit -m "feat(db): broken refs carry availableFrom — source libraries holding the missing section

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Migration 019 — backfill aliased projects

**Files:**
- Create: `src/db/migrations/019_backfill_project_copies.ts`

Verification is scripted psql (migrations are not vitest targets; CI runs this on an empty DB where it's a no-op).

- [ ] **Step 1: Write the migration**

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D2/D3 backfill (issue #94) — existing projects alias shared library
// rows. This migration (1) gives every project the built-in company master as
// its sole source (governs FUTURE resolution only), and (2) clones every
// aliased TOC row into a project-owned copy with full lineage + the paragraph
// origin map, then repoints project_specs. Same SQL clone pattern as runtime
// (src/db/queries/derive.ts) — frozen snapshot, no src/ imports.
//
// Aborts loudly if a project TOC holds the same section via two specs — the
// (section, project_id) unique index forbids two clones of one section;
// resolve duplicates manually (precedent: migration 016 down).

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    INSERT INTO project_sources (project_id, library_id, priority)
    SELECT p.id, (SELECT id FROM libraries WHERE name = 'Default Company Master'), 1
    FROM projects p
  `);

  // One clone id per aliased (project, master) join row.
  pgm.sql(`
    CREATE TEMP TABLE backfill_clone_map AS
    SELECT ps.project_id, ps.spec_id AS master_id, gen_random_uuid() AS clone_id
    FROM project_specs ps
    JOIN specs s ON s.id = ps.spec_id
    WHERE s.library_id IS NOT NULL
  `);

  pgm.sql(`
    INSERT INTO specs (id, section, title, source, project_id, library_id,
                       parent_spec_id, origin_version, content_version, origin_meta)
    SELECT cm.clone_id, s.section, s.title, s.source, cm.project_id, NULL,
           s.id, s.content_version, 1, s.origin_meta
    FROM backfill_clone_map cm
    JOIN specs s ON s.id = cm.master_id
  `);

  // Paragraph trees: UUID map per clone; parent remapped within the same clone.
  pgm.sql(`
    CREATE TEMP TABLE backfill_para_map AS
    SELECT cm.clone_id, p.id AS old_id, gen_random_uuid() AS new_id
    FROM backfill_clone_map cm
    JOIN paragraphs p ON p.spec_id = cm.master_id
  `);
  pgm.sql(`
    INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position,
                            vanish, revit_param, base_version, conflicts, origin_paragraph_id)
    SELECT pm.new_id, pm.clone_id, parent.new_id, p.node_type, p.text, p.position,
           p.vanish, p.revit_param, p.base_version, p.conflicts, p.id
    FROM backfill_para_map pm
    JOIN paragraphs p ON p.id = pm.old_id
    LEFT JOIN backfill_para_map parent
      ON parent.old_id = p.parent_id AND parent.clone_id = pm.clone_id
  `);

  // Outgoing refs, pass 1: section targets provisionally broken; intra-spec
  // paragraph targets remapped, cross-spec paragraph targets NULL (the scoped
  // tpm join cannot match another spec's paragraphs).
  pgm.sql(`
    INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type,
                                 target_spec_section, target_spec_id, target_paragraph_id,
                                 standard_code, reference_text, is_broken)
    SELECT cm.clone_id, spm.new_id, sr.target_type, sr.target_spec_section,
           NULL, tpm.new_id, sr.standard_code, sr.reference_text,
           (sr.target_type = 'section')
    FROM spec_references sr
    JOIN backfill_clone_map cm ON cm.master_id = sr.source_spec_id
    JOIN backfill_para_map spm
      ON spm.old_id = sr.source_paragraph_id AND spm.clone_id = cm.clone_id
    LEFT JOIN backfill_para_map tpm
      ON tpm.old_id = sr.target_paragraph_id AND tpm.clone_id = cm.clone_id
  `);

  // Repoint the TOC to the clones (position preserved — only spec_id changes).
  pgm.sql(`
    UPDATE project_specs ps
    SET spec_id = cm.clone_id
    FROM backfill_clone_map cm
    WHERE ps.project_id = cm.project_id AND ps.spec_id = cm.master_id
  `);

  // Pass 2: re-resolve section targets project-scope now that all of each
  // project's clones exist. Only clone refs match — nothing else has
  // project_id set before this migration.
  pgm.sql(`
    UPDATE spec_references sr
    SET target_spec_id = t.id, is_broken = false
    FROM specs src, specs t
    WHERE sr.source_spec_id = src.id
      AND src.project_id IS NOT NULL
      AND sr.target_type = 'section'
      AND t.project_id = src.project_id
      AND t.section = sr.target_spec_section
  `);

  pgm.sql(`DROP TABLE backfill_clone_map`);
  pgm.sql(`DROP TABLE backfill_para_map`);
};

export const down = (pgm: MigrationBuilder): void => {
  // Repoint TOC rows back at the masters, then delete ALL project-owned specs
  // (their paragraphs and outgoing refs cascade). Post-migration edits to
  // clones are lost on down — documented and accepted (design doc #94);
  // rollback is a dev-time operation.
  pgm.sql(`
    UPDATE project_specs ps
    SET spec_id = s.parent_spec_id
    FROM specs s
    WHERE s.id = ps.spec_id
      AND s.project_id IS NOT NULL
      AND s.parent_spec_id IS NOT NULL
  `);
  pgm.sql(`DELETE FROM specs WHERE project_id IS NOT NULL`);
  pgm.sql(`
    DELETE FROM project_sources
    WHERE library_id = (SELECT id FROM libraries WHERE name = 'Default Company Master')
      AND priority = 1
  `);
};
```

- [ ] **Step 2: Scripted verification on a seeded aliased project**

```bash
# Seed an aliased project the way pre-#94 code would have
docker exec specr-pg-94 psql -U postgres -d specr <<'SQL'
INSERT INTO specs (id, section, title, source, library_id)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '23 00 00', 'HVAC Backfill', 'unknown',
        (SELECT id FROM libraries WHERE name = 'Default Company Master'));
INSERT INTO paragraphs (id, spec_id, node_type, text, position)
VALUES ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'part', 'PART 1', 1);
INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
VALUES ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000002', 'article', 'SUMMARY', 1);
INSERT INTO projects (id, name) VALUES ('aaaaaaaa-0000-0000-0000-000000000004', 'Backfill Test');
INSERT INTO project_specs (project_id, spec_id, position)
VALUES ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 1);
SQL

DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate

docker exec specr-pg-94 psql -U postgres -d specr -c "
SELECT (ps.spec_id <> 'aaaaaaaa-0000-0000-0000-000000000001') AS toc_repointed,
       c.parent_spec_id = 'aaaaaaaa-0000-0000-0000-000000000001' AS lineage_ok,
       c.content_version = 1 AS fresh_version,
       (SELECT COUNT(*) FROM paragraphs WHERE spec_id = c.id) = 2 AS paras_cloned,
       (SELECT COUNT(*) FROM paragraphs
        WHERE spec_id = c.id AND origin_paragraph_id IS NOT NULL) = 2 AS origin_map_ok,
       (SELECT COUNT(*) FROM project_sources
        WHERE project_id = 'aaaaaaaa-0000-0000-0000-000000000004') = 1 AS source_seeded
FROM project_specs ps JOIN specs c ON c.id = ps.spec_id
WHERE ps.project_id = 'aaaaaaaa-0000-0000-0000-000000000004';"
```

Expected: one row, all columns `t`.

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate:down
docker exec specr-pg-94 psql -U postgres -d specr -c "
SELECT ps.spec_id = 'aaaaaaaa-0000-0000-0000-000000000001' AS realiased,
       (SELECT COUNT(*) FROM specs WHERE project_id IS NOT NULL) = 0 AS clones_gone
FROM project_specs ps WHERE ps.project_id = 'aaaaaaaa-0000-0000-0000-000000000004';"
```

Expected: `realiased = t`, `clones_gone = t`. Then re-apply and clean fixture:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
docker exec specr-pg-94 psql -U postgres -d specr -c "
DELETE FROM projects WHERE id = 'aaaaaaaa-0000-0000-0000-000000000004';
DELETE FROM specs WHERE project_id = 'aaaaaaaa-0000-0000-0000-000000000004';
DELETE FROM specs WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';"
```

(Note: delete project first — `project_specs` cascades — then the orphaned clone, then the master.)

- [ ] **Step 3: Full integration suite still green** (the backfill must not corrupt the test DB)

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration
```

- [ ] **Step 4: Lint + commit**

```bash
pnpm format && pnpm lint
git add src/db/migrations/019_backfill_project_copies.ts
git commit -m "feat(db): backfill — clone aliased project sections into owned copies

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: openapi.yaml

**Files:**
- Modify: `openapi.yaml` (excluded from LOC budget)

- [ ] **Step 1: Update the contract**

1. `POST /projects` requestBody: add to `required`: `sourceLibraryIds`; add property:

```yaml
                sourceLibraryIds:
                  type: array
                  minItems: 1
                  items:
                    type: string
                    format: uuid
                  description: >
                    Ordered source list — priority = array order (1-based). Each must be a
                    company- or client-tier library (ADR-015 D3); no duplicates. Section
                    resolution for POST /projects/{id}/specs walks this list.
```

   Add a `'422'` response: `description: 'Validation failed, unknown library, or reference-tier source'` with `ErrorResponse` schema.

2. `components/schemas/ProjectSummary` and `ProjectWithToc`: add to `required`: `sources`; add property:

```yaml
        sources:
          type: array
          description: Ordered source libraries (priority ascending)
          items:
            type: object
            required: [libraryId, name, tier, priority]
            properties:
              libraryId: { type: string, format: uuid }
              name: { type: string }
              tier: { type: string, enum: [company, client] }
              priority: { type: integer, minimum: 1 }
```

3. `POST /projects/{id}/specs`: summary `Add a section to a project TOC (copy-on-derive clone)`. requestBody schema → `required: [section]`, property:

```yaml
                section:
                  type: string
                  pattern: '^\d{2} \d{2} \d{2}(\.\d{2}( \d{2})?)?$'
                  description: CSI section number (expanded shape, ADR-020)
```

   Response `data` →

```yaml
                        type: object
                        required: [specId, section, position, source]
                        properties:
                          specId:
                            type: string
                            format: uuid
                            description: The project-owned clone's id (not the master's)
                          section: { type: string }
                          position:
                            type: integer
                            description: 1-based TOC position assigned to the section
                          source:
                            type: object
                            required: [libraryId, name]
                            properties:
                              libraryId: { type: string, format: uuid }
                              name: { type: string }
                          shadowed:
                            type: array
                            description: Lower-priority sources that also hold this section
                            items:
                              type: object
                              required: [libraryId, name]
                              properties:
                                libraryId: { type: string, format: uuid }
                                name: { type: string }
```

   Responses: 409 description → `'Section already in project'`; add `'422'`: `description: 'Malformed section number, or no source library holds the section'` with `ErrorResponse`.

4. `DELETE /projects/{id}/specs/{specId}`: summary `Remove a project-owned section copy (blocked if edited, unless force)`. Add parameter:

```yaml
        - name: force
          in: query
          required: false
          schema:
            type: boolean
            default: false
          description: Delete the copy even if it has project edits (content_version > 1)
```

   Add `'409'` response: `description: 'Section has project edits — repeat with ?force=true'` with `ErrorResponse`.

5. `components/schemas/BrokenRef`: add to `required`: `availableFrom`; add:

```yaml
        availableFrom:
          type: array
          description: >
            Project source libraries that hold the missing target section — an
            actionable "add this section" advisory. Priority order.
          items:
            type: object
            required: [libraryId, name]
            properties:
              libraryId: { type: string, format: uuid }
              name: { type: string }
```

- [ ] **Step 2: Validate + commit**

```bash
pnpm exec redocly lint openapi.yaml || true   # warnings acceptable if pre-existing; no NEW errors
git add openapi.yaml
git commit -m "docs(api): openapi — copy-on-derive project contracts (#94)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Final verification + cleanup

- [ ] **Step 1: Full local CI sequence on a FRESH database** (proves migrations 018+019 run clean from zero)

```bash
docker stop specr-pg-94 && sleep 2
docker run --rm -d --name specr-pg-94 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=specr -p 5434:5432 postgres:16
sleep 3
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm seed
pnpm lint && pnpm build && pnpm test
DATABASE_URL=postgres://postgres:postgres@localhost:5434/specr NODE_ENV=test pnpm test:integration
```

Expected: 19 migrations, everything green. Paste the actual output before claiming success (verification-before-completion).

- [ ] **Step 2: LOC sanity**

```bash
git diff main...HEAD --stat -- ':!openapi.yaml' ':!src/db/migrations' ':!docs' | tail -3
```

- [ ] **Step 3: Stop the container**

```bash
docker stop specr-pg-94
```

- [ ] **Step 4: Finish via superpowers:finishing-a-development-branch — option 2 (Push + PR)**

PR title: `feat(db): copy-on-derive — project sections become owned copies (#94)`
PR body must include: `Closes #94`, the design-decision summary table (from the design doc), a Testing section with tickable checkboxes (exact commands above), and `🤖 Co-authored by Claude (Fable 5)`.

---

## Self-review notes (already applied)

- **Spec coverage:** every design-doc test bullet maps to a test: lossless clone / UUID map / headline isolation / fallback / shadow / 422 / 409 (Task 3), removal guard + force + broken-ref preservation (Task 4), reference-tier + unknown-library rejection (Task 5), ref repaired on add + master refs untouched (Task 3), backfill up/down on seeded aliased project (Task 8), availableFrom (Task 7).
- **Cross-spec paragraph targets NULL:** enforced structurally by the clone-scoped `tp`/`tpm` joins (runtime + backfill) — covered implicitly; no master fixture has cross-spec paragraph targets, acceptable.
- **Type consistency:** `AddSectionResult`/`SourceLibraryRef`/`RemoveSectionOutcome` (derive.ts), `ProjectSource`/`InvalidSourceLibraryError` (projects.ts) — names used identically across tasks 3–7.
- **`unnest WITH ORDINALITY` returns bigint** — cast `u.ord::int` is in the code (priority is integer).
- **Wrap-once rule:** raw pg errors are wrapped exactly once in `DatabaseError` so `getPgCode` (one-level cause walk) finds `23505`.
