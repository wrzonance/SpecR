# External Content Association (#109) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a firm link its own external collateral (e.g. a PDF datasheet in a DMS) to a Part 2 product paragraph, storing only the link + provenance (never the licensed bytes), and surface those associations over REST and MCP.

**Architecture:** A new `paragraph_associations` table keyed on `paragraph_id` (the stable `w:sdt` UUID, so associations survive spec regeneration). Each row carries a dual-mode external reference — DMS connector identity (`external_provider` + `external_id`, ADR-014 D5) **or** `url` + `content_hash` — plus a human label and free-form `external_metadata` JSONB. A new `db/queries/associations.ts` module owns CRUD. A new REST sub-resource `GET/POST/DELETE /specs/:id/paragraphs/:nodeId/associations` exposes it. Reads are merged into the existing spec-tree (`getSpecTree`) and MCP `get_paragraph`/`get_spec` node shapes via `meta.associations`.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, PostgreSQL (node-pg-migrate, `pg`), vitest. ESM (`.js` import extensions, `import type`).

## Global Constraints

- **ESLint enforced, not advisory:** `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` 50, **`max-lines` 400 per file**, `no-console` (use `src/lib/logger.ts`), `@typescript-eslint/no-explicit-any` error, no non-null `!` outside tests.
- **TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `verbatimModuleSyntax`.** No `any`, no `as unknown as`, no type assertions across module boundaries.
- **Module boundaries are hard:** import only from a sibling barrel (`../db/index.js`), never an internal file. Typed errors extend `DatabaseError` (`src/db/errors.ts`); chain `cause`. Validate every external input with Zod.
- **Migrations are reversible** (paired `up`/`down`); add a NEW migration, never edit an existing one.
- **`openapi.yaml` is CI-enforced** by `src/api/contract.integration.test.ts` (bidirectional route↔spec coverage + response-schema validation). Any route change updates `openapi.yaml` in this PR. Use the `ApiResponse` envelope (`{ success, data | error }`).
- **MCP tools never throw** — return `{ isError: true, content: [...] }`; import DB fns from `../db/index.js`; use `z.uuid()` (Zod v4), not `z.string().uuid()`.
- **Commit scope = module changed** (`feat(db):`, `feat(api):`, `feat(mcp):`). End each commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **DB integration tests** run against real Postgres: `docker compose up -d postgres && pnpm migrate && pnpm seed`, then `pnpm test:integration`. Never mock the DB.

---

## File Structure

- **Create** `src/db/migrations/032_create_paragraph_associations.ts` — the table + constraints + indexes (up/down).
- **Create** `src/db/queries/associations.ts` — `createAssociation`, `listAssociationsForParagraph`, `listAssociationsForSpec`, `deleteAssociation`, typed errors, row→DTO mapping.
- **Create** `src/db/queries/associations.integration.test.ts` — query-layer tests (real Postgres).
- **Create** `src/api/associations.ts` — three Express handlers (create/list/delete).
- **Create** `src/api/associations.integration.test.ts` — REST acceptance + survives-regeneration acceptance.
- **Modify** `src/ast/types.ts` — add `ParagraphAssociation` to `SpecNodeMeta.associations`.
- **Modify** `src/ast/schemas.ts` + `src/ast/index.ts` — add `CreateAssociationBodySchema` (request validation) and barrel export.
- **Modify** `src/db/index.ts` — barrel-export the new query fns + types.
- **Modify** `src/db/queries/specs.ts` (`getSpecTree`) — merge associations into tree nodes via `meta.associations`.
- **Modify** `src/db/queries/paragraphs.ts` (`getParagraphWithAncestors`) — attach associations to the returned `node`.
- **Modify** `src/api/router.ts` — wire the three new routes.
- **Modify** `src/mcp/handlers.ts` — `get_paragraph` / `get_spec` already serialize `meta`, so associations ride along once the DB layer attaches them; add a test asserting MCP visibility.
- **Modify** `src/mcp/handlers.test.ts` (or a new MCP integration test) — assert `get_paragraph` surfaces associations.
- **Modify** `openapi.yaml` — document the three routes + `ParagraphAssociation` schema; add the `ParagraphAssociation` to `SpecNode.meta`.
- **Modify** `src/api/contract.integration.test.ts` — add the three new ops to `RESPONSE_ALLOWLIST` (or `RESPONSE_COVERED` if you add a response assertion).

### The association row shape (locked here)

```
paragraph_associations
  id              uuid  PK  default gen_random_uuid()
  paragraph_id    uuid  NOT NULL  REFERENCES paragraphs(id) ON DELETE CASCADE
  spec_id         uuid  NOT NULL  REFERENCES specs(id) ON DELETE CASCADE   -- denormalized for spec-tree queries
  label           text  NOT NULL                                          -- human caption, e.g. "Acme 4500 datasheet"
  external_provider  text                                                 -- ADR-014 opaque connector id, e.g. 'projectwise' (nullable)
  external_id        text                                                 -- provider doc id (nullable)
  url                text                                                 -- direct URL (nullable)
  content_hash       text                                                 -- sha256 hex of the referenced bytes (nullable)
  external_metadata  jsonb NOT NULL DEFAULT '{}'                          -- opaque provenance labels / attrs
  created_at      timestamptz NOT NULL default now()

CHECK ( (external_provider IS NOT NULL AND external_id IS NOT NULL) OR url IS NOT NULL )
  -- at least one identity present: DMS pair OR url. content_hash is provenance, optional alongside either.
INDEX on (paragraph_id)
INDEX on (spec_id)
```

**Why dual-mode (design decision):** ADR-014 D5 fixes the DMS identity as `external_provider` + `external_id` (opaque). ADR-019 affirms link + provenance, never bytes. A firm *with* a DMS connector links by the connector pair; a firm *without* one (the common near-term case) links by `url` + `content_hash`. One nullable-column table with a presence CHECK serves both without forking into two tables — and `spec_id` is denormalized so the spec-tree read is a single indexed query, while the survival guarantee rides on `paragraph_id` (the regeneration-stable `w:sdt` UUID).

---

## Task 1: Migration — `paragraph_associations` table

**Files:**
- Create: `src/db/migrations/032_create_paragraph_associations.ts`

**Interfaces:**
- Produces: table `paragraph_associations` with columns/constraints above. No TS exports.

- [ ] **Step 1: Write the migration**

```typescript
// src/db/migrations/032_create_paragraph_associations.ts
import type { MigrationBuilder } from 'node-pg-migrate';

// External content association (ADR-019 affirmed scope, #109): firms link their
// own collateral (e.g. a PDF datasheet) to a paragraph. We store the link +
// provenance only — never the licensed bytes (the DMS owns transport, ADR-014).
// Keyed on paragraph_id (the stable w:sdt UUID) so links survive regeneration.
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('paragraph_associations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    paragraph_id: { type: 'uuid', notNull: true, references: 'paragraphs', onDelete: 'CASCADE' },
    spec_id: { type: 'uuid', notNull: true, references: 'specs', onDelete: 'CASCADE' },
    label: { type: 'text', notNull: true },
    // ADR-014 D5 connector identity (opaque). Both present together or neither.
    external_provider: { type: 'text' },
    external_id: { type: 'text' },
    // URL + content-hash provenance for firms without a DMS connector.
    url: { type: 'text' },
    content_hash: { type: 'text' },
    external_metadata: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // At least one identity present: the DMS pair OR a url. content_hash is
  // optional provenance alongside either.
  pgm.addConstraint('paragraph_associations', 'paragraph_associations_identity_check', {
    check:
      '(external_provider IS NOT NULL AND external_id IS NOT NULL) OR url IS NOT NULL',
  });
  // Label must be non-empty — a blank caption is meaningless.
  pgm.addConstraint('paragraph_associations', 'paragraph_associations_label_check', {
    check: "btrim(label) <> ''",
  });

  pgm.createIndex('paragraph_associations', 'paragraph_id', {
    name: 'paragraph_associations_paragraph_idx',
  });
  pgm.createIndex('paragraph_associations', 'spec_id', {
    name: 'paragraph_associations_spec_idx',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('paragraph_associations', { cascade: true });
};
```

- [ ] **Step 2: Apply and roll back to prove reversibility**

Run: `docker compose up -d postgres && pnpm migrate && pnpm migrate:down && pnpm migrate`
Expected: `up` creates the table, `down 1` drops it, `up` recreates it — all exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/032_create_paragraph_associations.ts
git commit -m "feat(db): paragraph_associations table (#109)

Keyed on paragraph_id (stable w:sdt UUID) so external content links survive
spec regeneration. Dual identity: DMS connector pair (ADR-014 D5) or url+hash.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: AST type + request schema for associations

**Files:**
- Modify: `src/ast/types.ts` (add `ParagraphAssociation`, extend `SpecNodeMeta`)
- Modify: `src/ast/schemas.ts` (add `CreateAssociationBodySchema`)
- Modify: `src/ast/index.ts` (barrel-export both)
- Test: `src/ast/associations.test.ts` (new — schema unit tests, no DB)

**Interfaces:**
- Produces:
  - `interface ParagraphAssociation { readonly id: string; readonly label: string; readonly externalProvider?: string; readonly externalId?: string; readonly url?: string; readonly contentHash?: string; readonly externalMetadata: Record<string, unknown>; readonly createdAt: string }`
  - `SpecNodeMeta.associations?: readonly ParagraphAssociation[]`
  - `CreateAssociationBodySchema` (Zod) → `{ label: string; externalProvider?: string; externalId?: string; url?: string; contentHash?: string; externalMetadata?: Record<string, unknown> }` with a refine enforcing the same presence rule as the DB CHECK.

- [ ] **Step 1: Write the failing schema test**

```typescript
// src/ast/associations.test.ts
import { describe, it, expect } from 'vitest';
import { CreateAssociationBodySchema } from './index.js';

describe('CreateAssociationBodySchema', () => {
  it('accepts a DMS connector identity (provider + id)', () => {
    const r = CreateAssociationBodySchema.safeParse({
      label: 'Acme 4500 datasheet',
      externalProvider: 'projectwise',
      externalId: 'doc-123',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a url-only identity', () => {
    const r = CreateAssociationBodySchema.safeParse({
      label: 'Public cut sheet',
      url: 'https://example.com/sheet.pdf',
      contentHash: 'a'.repeat(64),
    });
    expect(r.success).toBe(true);
  });

  it('rejects when neither a url nor a complete provider pair is present', () => {
    const r = CreateAssociationBodySchema.safeParse({
      label: 'no identity',
      externalProvider: 'projectwise', // missing externalId
    });
    expect(r.success).toBe(false);
  });

  it('rejects a blank label', () => {
    const r = CreateAssociationBodySchema.safeParse({
      label: '   ',
      url: 'https://example.com/x.pdf',
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/ast/associations.test.ts`
Expected: FAIL — `CreateAssociationBodySchema` is not exported.

- [ ] **Step 3: Add the schema (`src/ast/schemas.ts`)**

```typescript
// Append to src/ast/schemas.ts
// External content association request (#109). Presence rule mirrors the
// paragraph_associations CHECK: a complete DMS pair OR a url.
export const CreateAssociationBodySchema = z
  .object({
    label: z.string().trim().min(1, 'label must be non-empty'),
    externalProvider: z.string().trim().min(1).optional(),
    externalId: z.string().trim().min(1).optional(),
    url: z.string().trim().url().optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'contentHash must be a sha256 hex digest')
      .optional(),
    externalMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (v) => v.url !== undefined || (v.externalProvider !== undefined && v.externalId !== undefined),
    { message: 'provide a url, or both externalProvider and externalId' }
  );
```

- [ ] **Step 4: Add the type (`src/ast/types.ts`)**

Add the interface near `SpecNodeMeta` and extend the meta:

```typescript
// External content association surfaced on a paragraph (#109). Link + provenance
// only — never the licensed bytes (ADR-019). Keyed on the paragraph's w:sdt UUID.
export interface ParagraphAssociation {
  readonly id: string;
  readonly label: string;
  /** DMS connector identity (ADR-014 D5). Present together with externalId or absent. */
  readonly externalProvider?: string;
  readonly externalId?: string;
  /** Direct URL provenance for firms without a DMS connector. */
  readonly url?: string;
  /** sha256 hex of the referenced bytes, when known. */
  readonly contentHash?: string;
  readonly externalMetadata: Record<string, unknown>;
  readonly createdAt: string;
}
```

In `SpecNodeMeta`, add:

```typescript
  /** External content links (#109). Absent === none. */
  readonly associations?: readonly ParagraphAssociation[];
```

- [ ] **Step 5: Export from the barrel (`src/ast/index.ts`)**

Add `CreateAssociationBodySchema` to the value exports and `ParagraphAssociation` to the type exports (follow the existing `export { ... } from './schemas.js'` / `export type { ... } from './types.js'` grouping).

- [ ] **Step 6: Run to verify it passes + lint**

Run: `pnpm vitest run src/ast/associations.test.ts && pnpm lint`
Expected: PASS; lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/ast/types.ts src/ast/schemas.ts src/ast/index.ts src/ast/associations.test.ts
git commit -m "feat(ast): ParagraphAssociation type + CreateAssociationBodySchema (#109)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: DB query layer — `associations.ts`

**Files:**
- Create: `src/db/queries/associations.ts`
- Create: `src/db/queries/associations.integration.test.ts`
- Modify: `src/db/index.ts` (barrel export)

**Interfaces:**
- Consumes: `pool`, `DatabaseError` from `../index.js`; `ParagraphAssociation` from `../../ast/index.js`.
- Produces (exported via `db/index.js`):
  - `createAssociation(paragraphId: string, input: CreateAssociationInput, db?: Pool): Promise<ParagraphAssociation>`
  - `listAssociationsForParagraph(paragraphId: string, db?: Queryable): Promise<readonly ParagraphAssociation[]>`
  - `listAssociationsForSpec(specId: string, db?: Queryable): Promise<ReadonlyMap<string, readonly ParagraphAssociation[]>>` — keyed by `paragraph_id`, for the spec-tree merge.
  - `deleteAssociation(paragraphId: string, associationId: string, db?: Pool): Promise<boolean>` — false when no row matched.
  - `class AssociationParagraphNotFoundError extends DatabaseError {}`
  - `interface CreateAssociationInput` (camelCase mirror of the body, all optional except `label`).

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/db/queries/associations.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  createAssociation,
  listAssociationsForParagraph,
  listAssociationsForSpec,
  deleteAssociation,
  AssociationParagraphNotFoundError,
} from './associations.js';

let specId: string;
let paragraphId: string;

async function seedSpecWithParagraph(): Promise<{ specId: string; paragraphId: string }> {
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source) VALUES ('09 91 00', 'Painting', 'unknown') RETURNING id`
  );
  const sId = spec.rows[0]!.id;
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'paragraph', 'Provide products as scheduled.', 1) RETURNING id`,
    [sId]
  );
  return { specId: sId, paragraphId: para.rows[0]!.id };
}

beforeAll(async () => {
  const seeded = await seedSpecWithParagraph();
  specId = seeded.specId;
  paragraphId = seeded.paragraphId;
});
afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
});
afterEach(async () => {
  await pool.query(`DELETE FROM paragraph_associations WHERE paragraph_id = $1`, [paragraphId]);
});

describe('paragraph_associations query layer', () => {
  it('creates and reads back a DMS-connector association', async () => {
    const created = await createAssociation(paragraphId, {
      label: 'Acme 4500 datasheet',
      externalProvider: 'projectwise',
      externalId: 'doc-123',
      externalMetadata: { revision: 'C' },
    });
    expect(created.label).toBe('Acme 4500 datasheet');
    expect(created.externalProvider).toBe('projectwise');
    expect(created.externalId).toBe('doc-123');
    expect(created.url).toBeUndefined();
    expect(created.externalMetadata).toEqual({ revision: 'C' });

    const list = await listAssociationsForParagraph(paragraphId);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.id);
  });

  it('creates a url-only association', async () => {
    const created = await createAssociation(paragraphId, {
      label: 'Public cut sheet',
      url: 'https://example.com/sheet.pdf',
      contentHash: 'a'.repeat(64),
    });
    expect(created.url).toBe('https://example.com/sheet.pdf');
    expect(created.contentHash).toBe('a'.repeat(64));
    expect(created.externalProvider).toBeUndefined();
  });

  it('groups associations by paragraph for a spec', async () => {
    await createAssociation(paragraphId, { label: 'one', url: 'https://e.com/1.pdf' });
    const map = await listAssociationsForSpec(specId);
    expect(map.get(paragraphId)).toHaveLength(1);
  });

  it('throws AssociationParagraphNotFoundError for a missing paragraph', async () => {
    await expect(
      createAssociation('00000000-0000-0000-0000-000000000000', {
        label: 'x',
        url: 'https://e.com/x.pdf',
      })
    ).rejects.toBeInstanceOf(AssociationParagraphNotFoundError);
  });

  it('deleteAssociation returns true on hit, false on miss', async () => {
    const a = await createAssociation(paragraphId, { label: 'd', url: 'https://e.com/d.pdf' });
    expect(await deleteAssociation(paragraphId, a.id)).toBe(true);
    expect(await deleteAssociation(paragraphId, a.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/db/queries/associations.integration.test.ts`
Expected: FAIL — `./associations.js` does not exist.

- [ ] **Step 3: Write `src/db/queries/associations.ts`**

```typescript
import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import type { ParagraphAssociation } from '../../ast/index.js';
import { logger } from '../../lib/logger.js';

interface Queryable {
  query: Pool['query'];
}

/** Target paragraph does not exist → 404 at the API layer. */
export class AssociationParagraphNotFoundError extends DatabaseError {}

export interface CreateAssociationInput {
  readonly label: string;
  readonly externalProvider?: string;
  readonly externalId?: string;
  readonly url?: string;
  readonly contentHash?: string;
  readonly externalMetadata?: Record<string, unknown>;
}

interface AssociationRow {
  readonly id: string;
  readonly paragraph_id: string;
  readonly label: string;
  readonly external_provider: string | null;
  readonly external_id: string | null;
  readonly url: string | null;
  readonly content_hash: string | null;
  readonly external_metadata: Record<string, unknown>;
  readonly created_at: Date;
}

const SELECT_COLS =
  'id, paragraph_id, label, external_provider, external_id, url, content_hash, external_metadata, created_at';

function mapRow(row: AssociationRow): ParagraphAssociation {
  return {
    id: row.id,
    label: row.label,
    ...(row.external_provider !== null ? { externalProvider: row.external_provider } : {}),
    ...(row.external_id !== null ? { externalId: row.external_id } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    externalMetadata: row.external_metadata,
    createdAt: row.created_at.toISOString(),
  };
}

async function resolveSpecId(paragraphId: string, db: Queryable): Promise<string> {
  const res = await db.query<{ spec_id: string }>(
    `SELECT spec_id FROM paragraphs WHERE id = $1`,
    [paragraphId]
  );
  const row = res.rows[0];
  if (!row) {
    throw new AssociationParagraphNotFoundError(`paragraph ${paragraphId} not found`);
  }
  return row.spec_id;
}

export async function createAssociation(
  paragraphId: string,
  input: CreateAssociationInput,
  db: Pool = pool
): Promise<ParagraphAssociation> {
  try {
    const specId = await resolveSpecId(paragraphId, db);
    const res = await db.query<AssociationRow>(
      `INSERT INTO paragraph_associations
         (paragraph_id, spec_id, label, external_provider, external_id, url, content_hash, external_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING ${SELECT_COLS}`,
      [
        paragraphId,
        specId,
        input.label,
        input.externalProvider ?? null,
        input.externalId ?? null,
        input.url ?? null,
        input.contentHash ?? null,
        JSON.stringify(input.externalMetadata ?? {}),
      ]
    );
    const row = res.rows[0];
    if (!row) throw new DatabaseError('createAssociation: insert returned no row');
    logger.info({ paragraphId, associationId: row.id }, 'association created');
    return mapRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`createAssociation failed for paragraph ${paragraphId}`, { cause: err });
  }
}

export async function listAssociationsForParagraph(
  paragraphId: string,
  db: Queryable = pool
): Promise<readonly ParagraphAssociation[]> {
  try {
    const res = await db.query<AssociationRow>(
      `SELECT ${SELECT_COLS} FROM paragraph_associations
       WHERE paragraph_id = $1 ORDER BY created_at, id`,
      [paragraphId]
    );
    return res.rows.map(mapRow);
  } catch (err) {
    throw new DatabaseError(`listAssociationsForParagraph failed for ${paragraphId}`, {
      cause: err,
    });
  }
}

export async function listAssociationsForSpec(
  specId: string,
  db: Queryable = pool
): Promise<ReadonlyMap<string, readonly ParagraphAssociation[]>> {
  try {
    const res = await db.query<AssociationRow>(
      `SELECT ${SELECT_COLS} FROM paragraph_associations
       WHERE spec_id = $1 ORDER BY created_at, id`,
      [specId]
    );
    const map = new Map<string, ParagraphAssociation[]>();
    for (const row of res.rows) {
      const list = map.get(row.paragraph_id) ?? [];
      list.push(mapRow(row));
      map.set(row.paragraph_id, list);
    }
    return map;
  } catch (err) {
    throw new DatabaseError(`listAssociationsForSpec failed for ${specId}`, { cause: err });
  }
}

export async function deleteAssociation(
  paragraphId: string,
  associationId: string,
  db: Pool = pool
): Promise<boolean> {
  try {
    const res = await db.query(
      `DELETE FROM paragraph_associations WHERE id = $1 AND paragraph_id = $2`,
      [associationId, paragraphId]
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    throw new DatabaseError(`deleteAssociation failed for ${associationId}`, { cause: err });
  }
}
```

- [ ] **Step 4: Barrel-export (`src/db/index.ts`)**

```typescript
export {
  createAssociation,
  listAssociationsForParagraph,
  listAssociationsForSpec,
  deleteAssociation,
  AssociationParagraphNotFoundError,
} from './queries/associations.js';
export type { CreateAssociationInput } from './queries/associations.js';
```

- [ ] **Step 5: Run to verify it passes + lint**

Run: `pnpm test:integration -- src/db/queries/associations.integration.test.ts && pnpm lint`
Expected: PASS; lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/associations.ts src/db/queries/associations.integration.test.ts src/db/index.ts
git commit -m "feat(db): paragraph association CRUD query layer (#109)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Merge associations into spec-tree and get_paragraph reads

**Files:**
- Modify: `src/db/queries/specs.ts` (`getSpecTree` — attach `meta.associations` per node)
- Modify: `src/db/queries/paragraphs.ts` (`getParagraphWithAncestors` — attach `meta.associations` to the returned node; the `ParagraphRow` shape gains `associations?`)
- Modify: `src/db/queries/paragraphs.ts` test — none new here; covered by Task 6's MCP test and Task 5's REST test. Add a focused query test below.
- Test: extend `src/db/queries/associations.integration.test.ts` with a "spec-tree surfaces associations" + "get_paragraph surfaces associations" case.

**Interfaces:**
- Consumes: `listAssociationsForSpec`, `listAssociationsForParagraph` from `./associations.js`.
- Produces: `getSpecTree(...).tree` nodes carry `meta.associations` when present; `getParagraphWithAncestors(...).node` carries `associations` when present.

**Note on boundaries:** `specs.ts` and `paragraphs.ts` are siblings of `associations.ts` within the same `db` module — direct sibling imports inside a module are allowed (the barrel rule applies *across* top-level modules). `derive.ts` already imports `./division-general.js` directly; follow that precedent.

- [ ] **Step 1: Write the failing read tests (append to `associations.integration.test.ts`)**

```typescript
import { getSpecTree, getParagraphWithAncestors } from '../index.js';

describe('associations surface in reads', () => {
  it('getSpecTree attaches meta.associations to the owning node', async () => {
    const a = await createAssociation(paragraphId, {
      label: 'tree link',
      url: 'https://example.com/t.pdf',
    });
    const result = await getSpecTree(specId);
    const node = result!.tree.parts.find((n) => n.id === paragraphId);
    expect(node?.meta.associations).toHaveLength(1);
    expect(node?.meta.associations?.[0]?.id).toBe(a.id);
  });

  it('getParagraphWithAncestors attaches associations to the node', async () => {
    const a = await createAssociation(paragraphId, {
      label: 'para link',
      url: 'https://example.com/p.pdf',
    });
    const result = await getParagraphWithAncestors(paragraphId);
    expect(result?.node.associations).toHaveLength(1);
    expect(result?.node.associations?.[0]?.id).toBe(a.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration -- src/db/queries/associations.integration.test.ts`
Expected: FAIL — `meta.associations` / `node.associations` are undefined.

- [ ] **Step 3: Wire `getSpecTree` (`src/db/queries/specs.ts`)**

Add `import { listAssociationsForSpec } from './associations.js';` at the top. After building `tree` (line ~213, where `buildNodeTree(paraResult.rows)` is assigned), fetch the association map and merge it in. Extract a small helper to keep `getSpecTree` under the 50-line cap:

```typescript
// New helper near buildNodeTree
function attachAssociations(
  nodes: readonly SpecNode[],
  byParagraph: ReadonlyMap<string, readonly ParagraphAssociation[]>
): readonly SpecNode[] {
  return nodes.map((node) => {
    const associations = byParagraph.get(node.id);
    const children = attachAssociations(node.children, byParagraph);
    return {
      ...node,
      children,
      meta: { ...node.meta, ...(associations && associations.length > 0 ? { associations } : {}) },
    };
  });
}
```

In `getSpecTree`, replace the `parts: buildNodeTree(paraResult.rows)` assembly so that:

```typescript
const associationMap = await listAssociationsForSpec(id);
const tree: SpecTree = {
  id: specRow.id,
  section: specRow.section ?? '',
  title: specRow.title ?? '',
  parts: attachAssociations(buildNodeTree(paraResult.rows), associationMap),
};
```

Add `ParagraphAssociation` to the `import type { ... } from '../../ast/index.js'` list.

- [ ] **Step 4: Wire `getParagraphWithAncestors` (`src/db/queries/paragraphs.ts`)**

Add `import { listAssociationsForParagraph } from './associations.js';`. Extend `ParagraphRow` with `readonly associations?: readonly ParagraphAssociation[];` (import the type). After computing `node`/`ancestors`, fetch associations for the leaf node id and merge:

```typescript
const associations = await listAssociationsForParagraph(id);
const nodeRow = toParagraphRow(node);
return {
  node: associations.length > 0 ? { ...nodeRow, associations } : nodeRow,
  ancestors: ancestors.map(toParagraphRow),
};
```

- [ ] **Step 5: Run to verify it passes + lint**

Run: `pnpm test:integration -- src/db/queries/associations.integration.test.ts && pnpm lint`
Expected: PASS; lint clean (watch `max-lines-per-function` on `getSpecTree`/`getParagraphWithAncestors` — extract if needed).

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/specs.ts src/db/queries/paragraphs.ts src/db/queries/associations.integration.test.ts
git commit -m "feat(db): surface associations in spec tree + get_paragraph reads (#109)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: REST sub-resource — create/list/delete + openapi + contract

**Files:**
- Create: `src/api/associations.ts` (three handlers)
- Create: `src/api/associations.integration.test.ts` (REST + survives-regeneration acceptance)
- Modify: `src/api/router.ts` (wire routes)
- Modify: `openapi.yaml` (paths + `ParagraphAssociation` schema + meta extension)
- Modify: `src/api/contract.integration.test.ts` (`RESPONSE_ALLOWLIST` entries)

**Interfaces:**
- Consumes: `createAssociation`, `listAssociationsForParagraph`, `deleteAssociation`, `AssociationParagraphNotFoundError` from `../db/index.js`; `CreateAssociationBodySchema` from `../ast/index.js`.
- Produces three Express routes under `/specs/:id/paragraphs/:nodeId/associations`:
  - `POST` → 201 `{ success, data: ParagraphAssociation }`; 400 invalid; 404 paragraph missing/wrong spec.
  - `GET` → 200 `{ success, data: ParagraphAssociation[] }`; 404 paragraph missing/wrong spec.
  - `DELETE /:associationId` → 204 (no body) on hit; 404 on miss.

**Spec-ownership rule:** the `:nodeId` must belong to `:id`. Validate by checking `spec_id` on the paragraph (reuse a lightweight query). On mismatch return 404 (not 403) — the association sub-resource simply doesn't exist under that spec path.

- [ ] **Step 1: Write the failing REST acceptance test**

```typescript
// src/api/associations.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let specId: string;
let paragraphId: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 3000;
  baseUrl = `http://localhost:${port}`;

  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source) VALUES ('09 91 00', 'Painting', 'unknown') RETURNING id`
  );
  specId = spec.rows[0]!.id;
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'paragraph', 'Provide products.', 1) RETURNING id`,
    [specId]
  );
  paragraphId = para.rows[0]!.id;
});
afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

const base = (): string => `${baseUrl}/specs/${specId}/paragraphs/${paragraphId}/associations`;

describe('paragraph associations REST', () => {
  it('associates a datasheet to a Part 2 paragraph, visible via REST', async () => {
    const create = await fetch(base(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Acme 4500 datasheet',
        externalProvider: 'projectwise',
        externalId: 'doc-123',
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { id: string; label: string } };
    expect(created.data.label).toBe('Acme 4500 datasheet');

    const list = await fetch(base());
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: readonly { id: string }[] };
    expect(listed.data.map((a) => a.id)).toContain(created.data.id);
  });

  it('rejects an association with no identity (400)', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'no identity' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s when the paragraph does not belong to the spec', async () => {
    const otherSpec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source) VALUES ('01 00 00', 'General', 'unknown') RETURNING id`
    );
    const otherId = otherSpec.rows[0]!.id;
    const res = await fetch(
      `${baseUrl}/specs/${otherId}/paragraphs/${paragraphId}/associations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'x', url: 'https://e.com/x.pdf' }),
      }
    );
    expect(res.status).toBe(404);
    await pool.query(`DELETE FROM specs WHERE id = $1`, [otherId]);
  });

  it('deletes an association (204) then 404 on re-delete', async () => {
    const create = await fetch(base(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'del me', url: 'https://e.com/d.pdf' }),
    });
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    const del = await fetch(`${base()}/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const again = await fetch(`${base()}/${id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration -- src/api/associations.integration.test.ts`
Expected: FAIL — routes 404 (not wired).

- [ ] **Step 3: Write `src/api/associations.ts`**

```typescript
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CreateAssociationBodySchema } from '../ast/index.js';
import {
  createAssociation,
  listAssociationsForParagraph,
  deleteAssociation,
  AssociationParagraphNotFoundError,
  pool,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

interface Ids {
  readonly specId: string;
  readonly nodeId: string;
}

/** Validate path ids and assert the paragraph belongs to the spec. Returns the
 *  ids on success, or null after writing the appropriate 400/404 response. */
async function resolveIds(req: Request, res: Response): Promise<Ids | null> {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return null;
  }
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  if (!nodeId.success) {
    res.status(400).json({ success: false, error: 'invalid node id' });
    return null;
  }
  const owner = await pool.query<{ spec_id: string }>(
    `SELECT spec_id FROM paragraphs WHERE id = $1`,
    [nodeId.data]
  );
  if (owner.rows[0]?.spec_id !== specId.data) {
    res.status(404).json({ success: false, error: 'paragraph not found in spec' });
    return null;
  }
  return { specId: specId.data, nodeId: nodeId.data };
}

export async function createAssociationHandler(req: Request, res: Response): Promise<void> {
  const ids = await resolveIds(req, res);
  if (!ids) return;
  const body = CreateAssociationBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: body.error.issues[0]?.message ?? 'invalid body' });
    return;
  }
  try {
    const created = await createAssociation(ids.nodeId, body.data);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    if (err instanceof AssociationParagraphNotFoundError) {
      res.status(404).json({ success: false, error: 'paragraph not found' });
      return;
    }
    logger.error({ err }, 'create association failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function listAssociationsHandler(req: Request, res: Response): Promise<void> {
  const ids = await resolveIds(req, res);
  if (!ids) return;
  try {
    const data = await listAssociationsForParagraph(ids.nodeId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error({ err }, 'list associations failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function deleteAssociationHandler(req: Request, res: Response): Promise<void> {
  const ids = await resolveIds(req, res);
  if (!ids) return;
  const associationId = z.uuid().safeParse(req.params['associationId']);
  if (!associationId.success) {
    res.status(400).json({ success: false, error: 'invalid association id' });
    return;
  }
  try {
    const deleted = await deleteAssociation(ids.nodeId, associationId.data);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'association not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'delete association failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

Note: confirm `pool` is exported from `src/db/index.js` (it is — `export const pool`). If a lint rule forbids importing `pool` into the API layer, replace the ownership check with a tiny exported query fn `getParagraphSpecId(nodeId)` in `associations.ts` and import that instead.

- [ ] **Step 4: Wire routes (`src/api/router.ts`)**

```typescript
import {
  createAssociationHandler,
  listAssociationsHandler,
  deleteAssociationHandler,
} from './associations.js';
// ...
router.get('/specs/:id/paragraphs/:nodeId/associations', listAssociationsHandler);
router.post('/specs/:id/paragraphs/:nodeId/associations', createAssociationHandler);
router.delete(
  '/specs/:id/paragraphs/:nodeId/associations/:associationId',
  deleteAssociationHandler
);
```

- [ ] **Step 5: Document in `openapi.yaml`**

Add a `ParagraphAssociation` schema under `components.schemas` (matching the DTO: `id`, `label`, optional `externalProvider`/`externalId`/`url`/`contentHash`, `externalMetadata` object, `createdAt` date-time; required `[id, label, externalMetadata, createdAt]`). Add `associations` (array of `ParagraphAssociation`) to the `SpecNode` `meta` schema. Add the two paths (`/specs/{id}/paragraphs/{nodeId}/associations` with `get` + `post`; `/specs/{id}/paragraphs/{nodeId}/associations/{associationId}` with `delete`) using `operationId`s `listAssociations`, `createAssociation`, `deleteAssociation`. POST request body `$ref`s a `CreateAssociation` schema mirroring `CreateAssociationBodySchema`. Reuse existing `SpecId` / `NodeId` parameters; add an `AssociationId` path parameter. Responses: POST 201/400/404/500, GET 200/404/500, DELETE 204/404/500 (reuse the shared `BadRequest`/`NotFound`/`InternalServerError` responses).

- [ ] **Step 6: Allowlist the new ops in the contract test (`src/api/contract.integration.test.ts`)**

Add to `RESPONSE_ALLOWLIST`:
```typescript
  'get /specs/{}/paragraphs/{}/associations',
  'post /specs/{}/paragraphs/{}/associations',
```
(DELETE returns 204 no-body, so it is not a success-JSON op and needs no allowlist entry; verify against `successJsonOps` — if the helper still lists it, add `'delete /specs/{}/paragraphs/{}/associations/{}'` too.)

- [ ] **Step 7: Run the REST acceptance + contract gate + lint**

Run: `pnpm test:integration -- src/api/associations.integration.test.ts src/api/contract.integration.test.ts && pnpm lint`
Expected: PASS — including the bidirectional route↔spec coverage check.

- [ ] **Step 8: Commit**

```bash
git add src/api/associations.ts src/api/associations.integration.test.ts src/api/router.ts openapi.yaml src/api/contract.integration.test.ts
git commit -m "feat(api): external content association REST sub-resource (#109)

GET/POST /specs/:id/paragraphs/:nodeId/associations + DELETE .../:associationId.
openapi.yaml documents the routes + ParagraphAssociation schema (contract gate).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: MCP visibility + regeneration-survival acceptance

**Files:**
- Modify: `src/mcp/handlers.test.ts` OR create `src/mcp/associations.integration.test.ts` (assert `get_paragraph` surfaces associations through the MCP handler)
- Create/extend: `src/api/associations.integration.test.ts` (add the survives-regeneration acceptance test)

**Interfaces:**
- Consumes: `handleGetParagraph` from `../mcp/handlers.js` (no signature change — associations ride along because the handler JSON-stringifies `getParagraphWithAncestors`, already wired in Task 4).

**MCP — no handler change needed.** `handleGetParagraph` serializes the full `getParagraphWithAncestors` result; Task 4 put `associations` on `node`. This task only *proves* it.

- [ ] **Step 1: Write the MCP visibility test**

```typescript
// src/mcp/associations.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, createAssociation } from '../db/index.js';
import { handleGetParagraph } from './handlers.js';

let specId: string;
let paragraphId: string;

beforeAll(async () => {
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source) VALUES ('09 91 00', 'Painting', 'unknown') RETURNING id`
  );
  specId = spec.rows[0]!.id;
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'paragraph', 'Provide products.', 1) RETURNING id`,
    [specId]
  );
  paragraphId = para.rows[0]!.id;
  await createAssociation(paragraphId, {
    label: 'Acme 4500 datasheet',
    externalProvider: 'projectwise',
    externalId: 'doc-123',
  });
});
afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
});

describe('MCP get_paragraph surfaces associations', () => {
  it('includes the association in the tool result JSON', async () => {
    const result = await handleGetParagraph({ paragraphId });
    expect('isError' in result).toBe(false);
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text) as {
      node: { associations?: readonly { label: string }[] };
    };
    expect(parsed.node.associations?.[0]?.label).toBe('Acme 4500 datasheet');
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `pnpm test:integration -- src/mcp/associations.integration.test.ts`
Expected: PASS (Task 4 already wired the read path).

- [ ] **Step 3: Write the survives-regeneration acceptance test (append to `src/api/associations.integration.test.ts`)**

This is the second hard acceptance criterion. "Regeneration" = AST → DOCX → re-parse/merge round-trips the paragraph but the `w:sdt` UUID is stable, so the association (keyed on `paragraph_id`) remains attached. We prove the invariant at the data layer: an association keyed on a paragraph UUID is still returned for that UUID after the spec's content is bumped (a regenerate/merge bumps `content_version` and may rewrite text, but never the paragraph UUID).

```typescript
import { createAssociation, getParagraphWithAncestors } from '../db/index.js';

describe('associations survive spec regeneration (keyed on paragraph UUID)', () => {
  it('keeps the association attached after the paragraph text + spec version change', async () => {
    const a = await createAssociation(paragraphId, {
      label: 'survives regen',
      url: 'https://example.com/keep.pdf',
    });
    // Simulate a regenerate/merge: text rewritten, spec content_version bumped,
    // but the paragraph UUID (the w:sdt anchor) is preserved.
    await pool.query(
      `UPDATE paragraphs SET text = 'Regenerated text', base_version = base_version + 1 WHERE id = $1`,
      [paragraphId]
    );
    await pool.query(
      `UPDATE specs SET content_version = content_version + 1 WHERE id = $1`,
      [specId]
    );
    const result = await getParagraphWithAncestors(paragraphId);
    expect(result?.node.associations?.map((x) => x.id)).toContain(a.id);
  });
});
```

- [ ] **Step 4: Run the full acceptance suite**

Run: `pnpm test:integration -- src/api/associations.integration.test.ts src/mcp/associations.integration.test.ts`
Expected: PASS — both acceptance criteria green (REST+MCP visibility; survives regeneration).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/associations.integration.test.ts src/api/associations.integration.test.ts
git commit -m "test: MCP visibility + survives-regeneration acceptance for associations (#109)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full green + finish

**Files:** none (verification only).

- [ ] **Step 1: Lint the whole tree**

Run: `pnpm lint`
Expected: clean (eslint + tsc --noEmit + prettier).

- [ ] **Step 2: Unit tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Full integration suite (DB up + migrated + seeded)**

Run: `docker compose up -d postgres && pnpm migrate && pnpm seed && pnpm test:integration`
Expected: PASS — including `contract.integration.test.ts` (route↔spec coverage) and `roundtrip.integration.test.ts`.

- [ ] **Step 4: Finish the branch**

Use `superpowers:finishing-a-development-branch`, option 2 (Push + PR). PR body includes `Closes #109`, a `## Design decisions` section (dual identity model: ADR-014 connector pair vs url+hash, the `paragraph_associations` shape, 404-not-403 for cross-spec, keyed on paragraph UUID for regeneration survival), and a Testing checklist. End the PR body + final commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Self-Review

**Spec coverage:**
- "Association model: paragraph/spec ↔ external document reference (DMS `external_id` per ADR-014, or URL + hash)" → Task 1 (table, dual identity) + Task 3 (CRUD).
- "Surfaced in get_paragraph + spec tree responses" → Task 4 (DB merge) + Task 6 (MCP proof). Spec tree is `GET /specs/:id` (Task 4) and MCP `get_spec` rides the same `getSpecTree`.
- "Visible via REST + MCP" → Task 5 (REST sub-resource) + Task 6 (MCP).
- "Survives spec regeneration (keyed on paragraph UUID)" → Task 1 (`paragraph_id` FK, the survival key) + Task 6 Step 3 (acceptance test).
- "Store link + provenance only, never the bytes" → Task 1 columns (no blob column exists); enforced by omission + the CHECK.
- Out of scope (bytes/transport/scheduling) → not implemented. Good.

**Placeholder scan:** every code step carries full code; openapi (Task 5 Step 5) is described field-by-field against the locked DTO rather than pasted YAML — acceptable because the exact schema shape is fully specified in the DTO and the row shape; the implementer mirrors existing `components.schemas` entries.

**Type consistency:** `ParagraphAssociation` (Task 2) is the single DTO used by `mapRow` (Task 3), `meta.associations` (Task 4), REST (Task 5), MCP (Task 6). `CreateAssociationInput` (camelCase) mirrors `CreateAssociationBodySchema` output. `createAssociation`/`listAssociationsForParagraph`/`listAssociationsForSpec`/`deleteAssociation` names are identical across Tasks 3–6. `AssociationParagraphNotFoundError` consistent. The presence rule (DMS pair OR url) is identical in the Zod refine (Task 2), the DB CHECK (Task 1), and the API 400 path (Task 5).
