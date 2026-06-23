# Onboarding Finalize / Reopen (O-11, #139) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `specs.onboarding_status ∈ {review, active}`, plus `POST /specs/:id/finalize` (review→active, snapshot working conventions to the library profile) and `POST /specs/:id/reopen` (active→review), surfaced on `GET /specs/:id` and MCP `get_spec`.

**Architecture:** A new reversible migration adds the column (default `active` backfills existing rows). The O-8 import path persists new specs at `review`. A small `onboarding.ts` query module owns the status read + the two transitions (the finalize transition also snapshots the resolved convention rules into the library's own profile via the existing `upsertLibraryConvention`). Thin Express handlers wrap the queries; the status surfaces on the existing GET /specs/:id and MCP get_spec responses.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, node-pg-migrate, vitest, PostgreSQL.

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, `no-console` = error, `@typescript-eslint/no-explicit-any` = error. No non-null `!` outside tests.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (relative imports end in `.js`; type-only imports use `import type`).
- Module boundaries: import only from a sibling module's barrel (`../db/index.js`, `../ast/index.js`); never internals.
- Typed boundary errors extend `SpecrError`/`DatabaseError`; chain `cause`. Validate request params with Zod (`z.uuid()`).
- `openapi.yaml` is CI-enforced: every new route + changed response shape MUST be documented in the same PR; new routes added to the contract-test `RESPONSE_ALLOWLIST`.
- MCP tools never throw — return `{ isError: true }`; import DB fns from `../db/index.js`; use `z.uuid()`.
- No `console.*` in `src/`; use `src/lib/logger.ts`.
- Migration: next free number is **033**, reversible up + down.
- Commit scope = module changed, e.g. `feat(db):`, `feat(api):`, `feat(mcp):`. Trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Migration 033 — `specs.onboarding_status`

**Files:**
- Create: `src/db/migrations/033_add_onboarding_status.ts`

**Interfaces:**
- Produces: `specs.onboarding_status text NOT NULL DEFAULT 'active'` with CHECK `IN ('review','active')`; existing rows backfill to `active`.

- [ ] **Step 1: Write the migration**

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

// O-11 (ADR-022 D6) — onboarding_status records whether a human has reviewed the
// machine's first pass. Deliberately DISTINCT from lifecycle_state (migration 025,
// issuance posture). Default 'active' backfills existing rows; O-8 imports (#135)
// explicitly insert 'review'. Advisory only — no endpoint write-blocks on it.
const ONBOARDING_STATES = "('review','active')";

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('specs', {
    onboarding_status: { type: 'text', notNull: true, default: 'active' },
  });
  pgm.addConstraint('specs', 'specs_onboarding_status_check', {
    check: `onboarding_status IN ${ONBOARDING_STATES}`,
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('specs', 'specs_onboarding_status_check');
  pgm.dropColumns('specs', ['onboarding_status']);
};
```

- [ ] **Step 2: Run migration up + down round-trip**

Run: `pnpm migrate && pnpm migrate:down && pnpm migrate`
Expected: all succeed; `033_add_onboarding_status` applies, rolls back, re-applies clean.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/033_add_onboarding_status.ts
git commit -m "feat(db): migration 033 — specs.onboarding_status (review|active)"
```

---

### Task 2: DB query module — read status + finalize/reopen transitions

**Files:**
- Create: `src/db/queries/onboarding.ts`
- Create: `src/db/queries/onboarding.integration.test.ts`
- Modify: `src/db/index.ts` (export the new functions + types)
- Modify: `src/db/queries/specs.ts:287-303` (persistParsedSpec INSERT → add `onboarding_status` = `'review'`)

**Interfaces:**
- Consumes: `pool`, `DatabaseError` from `../index.js`; `getConventionForLibrary`, `upsertLibraryConvention` from `./conventions.js`.
- Produces:
  - `type OnboardingStatus = 'review' | 'active'`
  - `getOnboardingStatus(specId: string): Promise<OnboardingStatus | null>` (null = spec not found)
  - `type FinalizeOutcome = { status: 'finalized' | 'already-active' | 'not-found' }`
  - `finalizeOnboarding(specId: string): Promise<FinalizeOutcome>` — review→active; snapshots resolved convention rules to the library's own profile.
  - `type ReopenOutcome = { status: 'reopened' | 'already-review' | 'not-found' }`
  - `reopenOnboarding(specId: string): Promise<ReopenOutcome>` — active→review.

- [ ] **Step 1: Write failing integration tests**

```typescript
// src/db/queries/onboarding.integration.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  getOnboardingStatus,
  finalizeOnboarding,
  reopenOnboarding,
} from './onboarding.js';
import { createLibrary } from './libraries.js';
import { getConventionForLibrary } from './conventions.js';

async function makeSpec(libraryId: string, status: 'review' | 'active'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, onboarding_status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['09 91 26', 't', 'docx', libraryId, status]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no spec id');
  return id;
}

afterEach(async () => {
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fin-%')`
  );
  await pool.query(
    `DELETE FROM editing_conventions WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fin-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lib-fin-%'`);
});

describe('onboarding status transitions', () => {
  it('getOnboardingStatus returns the stored status, null for missing', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-get', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    expect(await getOnboardingStatus(specId)).toBe('review');
    expect(await getOnboardingStatus('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('finalize flips review→active and snapshots the library convention profile', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-snap', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    // Before: the library has no own profile (falls back to built-in).
    const beforeOwn = await pool.query(
      `SELECT 1 FROM editing_conventions WHERE library_id = $1`,
      [lib.id]
    );
    expect(beforeOwn.rowCount).toBe(0);

    const out = await finalizeOnboarding(specId);
    expect(out.status).toBe('finalized');
    expect(await getOnboardingStatus(specId)).toBe('active');

    // After: the library now OWNS a convention profile (so future imports self-classify).
    const afterOwn = await pool.query(
      `SELECT 1 FROM editing_conventions WHERE library_id = $1`,
      [lib.id]
    );
    expect(afterOwn.rowCount).toBe(1);
    // And it equals the previously-resolved (built-in) rules.
    const resolved = await getConventionForLibrary(lib.id);
    expect(resolved?.libraryId).toBe(lib.id);
  });

  it('finalize on an already-active spec is an idempotent no-op', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-idem', owner: 'o' });
    const specId = await makeSpec(lib.id, 'active');
    const out = await finalizeOnboarding(specId);
    expect(out.status).toBe('already-active');
    expect(await getOnboardingStatus(specId)).toBe('active');
  });

  it('finalize on a missing spec returns not-found', async () => {
    const out = await finalizeOnboarding('00000000-0000-0000-0000-000000000000');
    expect(out.status).toBe('not-found');
  });

  it('reopen flips active→review; already-review and not-found are reported', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-reopen', owner: 'o' });
    const activeId = await makeSpec(lib.id, 'active');
    expect((await reopenOnboarding(activeId)).status).toBe('reopened');
    expect(await getOnboardingStatus(activeId)).toBe('review');

    const reviewId = await makeSpec(lib.id, 'review');
    expect((await reopenOnboarding(reviewId)).status).toBe('already-review');
    expect((await reopenOnboarding('00000000-0000-0000-0000-000000000000')).status).toBe(
      'not-found'
    );
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test:integration -- onboarding.integration` (from src/db/queries)
Expected: FAIL — `getOnboardingStatus` is not exported / module missing.

- [ ] **Step 3: Implement the query module**

```typescript
// src/db/queries/onboarding.ts
import { pool, DatabaseError } from '../index.js';
import { getConventionForLibrary, upsertLibraryConvention } from './conventions.js';

export type OnboardingStatus = 'review' | 'active';

export type FinalizeOutcome = { readonly status: 'finalized' | 'already-active' | 'not-found' };
export type ReopenOutcome = { readonly status: 'reopened' | 'already-review' | 'not-found' };

interface StatusRow {
  readonly onboarding_status: OnboardingStatus;
  readonly library_id: string | null;
}

export async function getOnboardingStatus(specId: string): Promise<OnboardingStatus | null> {
  try {
    const res = await pool.query<{ onboarding_status: OnboardingStatus }>(
      `SELECT onboarding_status FROM specs WHERE id = $1`,
      [specId]
    );
    return res.rows[0]?.onboarding_status ?? null;
  } catch (err) {
    throw new DatabaseError('getOnboardingStatus failed', { cause: err });
  }
}

// review → active. Also snapshot the rules that classified this spec into the
// library's OWN convention profile, so the next import from this library
// self-classifies against them instead of falling back to the built-in default
// (#139 / ADR-022). A spec with no library (project working copy) just flips.
export async function finalizeOnboarding(specId: string): Promise<FinalizeOutcome> {
  try {
    const cur = await pool.query<StatusRow>(
      `SELECT onboarding_status, library_id FROM specs WHERE id = $1`,
      [specId]
    );
    const row = cur.rows[0];
    if (!row) return { status: 'not-found' };
    if (row.onboarding_status === 'active') return { status: 'already-active' };
    if (row.library_id) await snapshotLibraryConvention(row.library_id);
    await pool.query(
      `UPDATE specs SET onboarding_status = 'active', updated_at = now() WHERE id = $1`,
      [specId]
    );
    return { status: 'finalized' };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('finalizeOnboarding failed', { cause: err });
  }
}

async function snapshotLibraryConvention(libraryId: string): Promise<void> {
  const resolved = await getConventionForLibrary(libraryId);
  if (!resolved) return; // no rules to snapshot (no built-in seeded) — flip only.
  await upsertLibraryConvention(libraryId, resolved.name, resolved.rules);
}

// active → review. Purely informational; nothing gates on it (#139).
export async function reopenOnboarding(specId: string): Promise<ReopenOutcome> {
  try {
    const cur = await pool.query<{ onboarding_status: OnboardingStatus }>(
      `SELECT onboarding_status FROM specs WHERE id = $1`,
      [specId]
    );
    const status = cur.rows[0]?.onboarding_status;
    if (status === undefined) return { status: 'not-found' };
    if (status === 'review') return { status: 'already-review' };
    await pool.query(
      `UPDATE specs SET onboarding_status = 'review', updated_at = now() WHERE id = $1`,
      [specId]
    );
    return { status: 'reopened' };
  } catch (err) {
    throw new DatabaseError('reopenOnboarding failed', { cause: err });
  }
}
```

- [ ] **Step 4: Export from the db barrel** — add to `src/db/index.ts` (near other spec-query exports):

```typescript
export {
  getOnboardingStatus,
  finalizeOnboarding,
  reopenOnboarding,
} from './queries/onboarding.js';
export type {
  OnboardingStatus,
  FinalizeOutcome,
  ReopenOutcome,
} from './queries/onboarding.js';
```

- [ ] **Step 5: Persist O-8 imports at `review`** — in `src/db/queries/specs.ts`, the `persistParsedSpec` INSERT adds the column. Change the INSERT column list + values:

```sql
INSERT INTO specs (section, title, source, library_id, origin_meta, onboarding_status)
VALUES ($1, $2, $3, $4, $5::jsonb, 'review')
ON CONFLICT (section, source, library_id) WHERE library_id IS NOT NULL DO UPDATE
  SET title = EXCLUDED.title,
      updated_at = now(),
      content_version = specs.content_version + 1,
      origin_meta = COALESCE(EXCLUDED.origin_meta, specs.origin_meta)
RETURNING id
```

Note: on re-import (ON CONFLICT) the status is intentionally NOT reset — a finalized spec re-imported keeps `active` (the human's review stands). New rows land at `review`.

- [ ] **Step 6: Run tests, verify they pass**

Run: `pnpm test:integration -- onboarding.integration`
Expected: PASS (all 5 cases).

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/onboarding.ts src/db/queries/onboarding.integration.test.ts src/db/index.ts src/db/queries/specs.ts
git commit -m "feat(db): onboarding_status transitions + O-8 imports start at review"
```

---

### Task 3: API handlers — POST /specs/:id/finalize and /reopen

**Files:**
- Create: `src/api/onboarding-status.ts`
- Modify: `src/api/router.ts` (register the two routes)
- Modify: `src/api/onboarding-status.integration.test.ts` (new test file)

**Interfaces:**
- Consumes: `finalizeOnboarding`, `reopenOnboarding` from `../db/index.js`; `z.uuid()`; `logger`.
- Produces:
  - `finalizeSpecHandler(req, res)` — 200 `{ success, data: { onboardingStatus: 'active' } }`; idempotent no-op also 200; 400 bad id; 404 not-found; 500.
  - `reopenSpecHandler(req, res)` — 200 `{ success, data: { onboardingStatus: 'review' } }`; 400/404/500.

- [ ] **Step 1: Write failing integration tests**

```typescript
// src/api/onboarding-status.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const a = server.address();
  baseUrl = `http://localhost:${typeof a === 'object' && a ? a.port : 3000}`;
});

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

afterEach(async () => {
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fapi-%')`
  );
  await pool.query(
    `DELETE FROM editing_conventions WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fapi-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lib-fapi-%'`);
});

async function makeSpec(libraryId: string, status: 'review' | 'active'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, onboarding_status)
     VALUES ('09 91 26', 't', 'docx', $1, $2) RETURNING id`,
    [libraryId, status]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no spec id');
  return id;
}

describe('POST /specs/:id/finalize and /reopen', () => {
  it('finalize flips review→active and surfaces it on GET /specs/:id', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-fin', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    const res = await fetch(`${baseUrl}/specs/${specId}/finalize`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { onboardingStatus: string } };
    expect(body.success).toBe(true);
    expect(body.data.onboardingStatus).toBe('active');

    const get = await fetch(`${baseUrl}/specs/${specId}`);
    const getBody = (await get.json()) as { data: { onboardingStatus: string } };
    expect(getBody.data.onboardingStatus).toBe('active');
  });

  it('finalize on an already-active spec is an idempotent 200 no-op', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-idem', owner: 'o' });
    const specId = await makeSpec(lib.id, 'active');
    const res = await fetch(`${baseUrl}/specs/${specId}/finalize`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { onboardingStatus: string } };
    expect(body.data.onboardingStatus).toBe('active');
  });

  it('reopen flips active→review', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-reopen', owner: 'o' });
    const specId = await makeSpec(lib.id, 'active');
    const res = await fetch(`${baseUrl}/specs/${specId}/reopen`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { onboardingStatus: string } };
    expect(body.data.onboardingStatus).toBe('review');
  });

  it('finalize on a missing spec → 404; bad id → 400', async () => {
    const missing = await fetch(
      `${baseUrl}/specs/00000000-0000-0000-0000-000000000000/finalize`,
      { method: 'POST' }
    );
    expect(missing.status).toBe(404);
    const bad = await fetch(`${baseUrl}/specs/not-a-uuid/finalize`, { method: 'POST' });
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify fail** — Run: `pnpm test:integration -- onboarding-status.integration` → FAIL (routes 404 / handlers missing).

- [ ] **Step 3: Implement handlers**

```typescript
// src/api/onboarding-status.ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import { finalizeOnboarding, reopenOnboarding } from '../db/index.js';
import { logger } from '../lib/logger.js';

const SPEC_ID = z.uuid();

export async function finalizeSpecHandler(req: Request, res: Response): Promise<void> {
  const id = SPEC_ID.safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    const outcome = await finalizeOnboarding(id.data);
    if (outcome.status === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    // 'finalized' and 'already-active' are both 200 — finalize is idempotent (#139).
    res.status(200).json({ success: true, data: { onboardingStatus: 'active' } });
  } catch (err) {
    logger.error({ err }, 'finalize spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function reopenSpecHandler(req: Request, res: Response): Promise<void> {
  const id = SPEC_ID.safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  try {
    const outcome = await reopenOnboarding(id.data);
    if (outcome.status === 'not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(200).json({ success: true, data: { onboardingStatus: 'review' } });
  } catch (err) {
    logger.error({ err }, 'reopen spec failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

- [ ] **Step 4: Register routes** — in `src/api/router.ts`, add the import and routes near the other `/specs/:id/...` POST routes (after the reclassify route):

```typescript
import { finalizeSpecHandler, reopenSpecHandler } from './onboarding-status.js';
// ...
router.post('/specs/:id/finalize', finalizeSpecHandler);
router.post('/specs/:id/reopen', reopenSpecHandler);
```

- [ ] **Step 5: Run, verify pass** — Run: `pnpm test:integration -- onboarding-status.integration` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/onboarding-status.ts src/api/onboarding-status.integration.test.ts src/api/router.ts
git commit -m "feat(api): POST /specs/:id/finalize and /reopen — onboarding status"
```

---

### Task 4: Surface onboardingStatus on GET /specs/:id + MCP get_spec

**Files:**
- Modify: `src/api/specs.ts:6-27` (getSpecHandler — add onboardingStatus to the data payload)
- Modify: `src/mcp/handlers.ts:130-143` (handleGetSpec — include onboardingStatus)

**Interfaces:**
- Consumes: `getOnboardingStatus` from `../db/index.js`.
- Produces: GET /specs/:id `data.onboardingStatus: 'review' | 'active'`; MCP get_spec JSON includes `onboardingStatus`.

- [ ] **Step 1: Extend the GET /specs/:id integration test** — append to `src/api/onboarding-status.integration.test.ts` (the GET assertion in the finalize test already covers `active`; add a `review` case):

```typescript
  it('GET /specs/:id surfaces onboardingStatus:review for an unfinalized spec', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-getrev', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    const get = await fetch(`${baseUrl}/specs/${specId}`);
    const body = (await get.json()) as { data: { onboardingStatus: string } };
    expect(body.data.onboardingStatus).toBe('review');
  });
```

- [ ] **Step 2: Run, verify fail** — Run: `pnpm test:integration -- onboarding-status.integration` → FAIL (onboardingStatus undefined on GET).

- [ ] **Step 3: Implement — getSpecHandler** in `src/api/specs.ts`, add `getOnboardingStatus` to the existing import and merge it into the response:

```typescript
import { getSpecTree, updateSpec, getSpecLineage, getSpecStyleSource, getOnboardingStatus } from '../db/index.js';
// ... inside getSpecHandler, after styleSource:
    const onboardingStatus = await getOnboardingStatus(id);
    res.status(200).json({
      success: true,
      data: { ...result.tree, styleSource, onboardingStatus },
    });
```

- [ ] **Step 4: Implement — handleGetSpec** in `src/mcp/handlers.ts`, add the import (alongside `getSpecStyleSource`) and include the field:

```typescript
import { /* … */ getSpecTree, getSpecStyleSource, getOnboardingStatus } from '../db/index.js';
// ... inside handleGetSpec, after styleSource:
    const onboardingStatus = await getOnboardingStatus(specId);
    const text = JSON.stringify({ ...result, styleSource, onboardingStatus }, null, 2);
```

- [ ] **Step 5: Run, verify pass** — Run: `pnpm test:integration -- onboarding-status.integration` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/specs.ts src/mcp/handlers.ts
git commit -m "feat(api,mcp): surface onboardingStatus on GET /specs/:id + get_spec"
```

---

### Task 5: openapi.yaml + contract allowlist

**Files:**
- Modify: `openapi.yaml` (add the two POST paths; add `onboardingStatus` to SpecTree schema)
- Modify: `src/api/contract.integration.test.ts` (add the two routes to RESPONSE_ALLOWLIST)

**Interfaces:**
- Produces: documented `post /specs/{id}/finalize`, `post /specs/{id}/reopen`; SpecTree `onboardingStatus` enum property.

- [ ] **Step 1: Add the two POST operations to openapi.yaml** — insert after the `/specs/{id}/reclassify` block (around line 370). Both share a 200 `{ success, data: { onboardingStatus } }` shape with 400/404/500:

```yaml
  /specs/{id}/finalize:
    post:
      operationId: finalizeSpec
      summary: Finalize onboarding (review → active)
      description: >
        Marks a human as having reviewed the machine's first pass: flips
        `onboardingStatus` from `review` to `active` (ADR-022 D6). Also snapshots
        the spec's resolved convention rules into its library's OWN convention
        profile, so the next import from that library self-classifies against them
        instead of falling back to the built-in default. `active` does NOT seal the
        spec — corrections, reclassify, conventions and style endpoints keep working.
        Idempotent: finalizing an already-active spec returns 200 unchanged.
      tags: [specs]
      parameters:
        - $ref: '#/components/parameters/SpecId'
      responses:
        '200':
          description: Onboarding finalized (or already active)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        type: object
                        required: [onboardingStatus]
                        properties:
                          onboardingStatus:
                            type: string
                            enum: [active]
        '400':
          $ref: '#/components/responses/BadRequest'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /specs/{id}/reopen:
    post:
      operationId: reopenSpec
      summary: Reopen onboarding (active → review)
      description: >
        Flips `onboardingStatus` from `active` back to `review` (ADR-022 D6).
        Purely informational — no endpoint behavior gates on it. Reopening an
        already-`review` spec returns 200 unchanged.
      tags: [specs]
      parameters:
        - $ref: '#/components/parameters/SpecId'
      responses:
        '200':
          description: Onboarding reopened (or already in review)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        type: object
                        required: [onboardingStatus]
                        properties:
                          onboardingStatus:
                            type: string
                            enum: [review]
        '400':
          $ref: '#/components/responses/BadRequest'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

- [ ] **Step 2: Add `onboardingStatus` to the SpecTree schema** — in the `SpecTree` properties (around line 3496, alongside `styleSource`):

```yaml
        onboardingStatus:
          description: >
            Whether a human has reviewed the machine's first pass (ADR-022 D6).
            Only present on GET /specs/{id}.
          type: string
          enum: [review, active]
```

- [ ] **Step 3: Add the two routes to the contract RESPONSE_ALLOWLIST** — in `src/api/contract.integration.test.ts`, add to the `RESPONSE_ALLOWLIST` set:

```typescript
  'post /specs/{}/finalize',
  'post /specs/{}/reopen',
```

- [ ] **Step 4: Run the contract test, verify it passes**

Run: `pnpm test:integration -- contract.integration`
Expected: PASS — structural coverage (route↔spec both directions) green; no undocumented route, no unimplemented op.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/api/contract.integration.test.ts
git commit -m "docs(api): document finalize/reopen + onboardingStatus in openapi.yaml"
```

---

### Task 6: Flexibility regression test — loop endpoints work on an active spec

**Files:**
- Modify: `src/api/onboarding-status.integration.test.ts` (add a flexibility describe block)

**Interfaces:**
- Consumes: the finalize endpoint, plus the existing reclassify (#136), conventions (#137), style-source (#138) endpoints.

- [ ] **Step 1: Write the flexibility regression test** — proves `active` does not seal the spec. Use the O-8 import path so the spec has real paragraphs/source_facts (reclassify needs them), then finalize, then exercise the loop endpoints. Append to the test file:

```typescript
describe('flexibility: an active (finalized) spec still accepts loop edits (#139)', () => {
  it('reclassify (#136), conventions (#137), style-source (#138) all work post-finalize', async () => {
    const { createLibrary } = await import('../db/index.js');
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-flex', owner: 'o' });
    const docx = readFileSync(resolve('tests/fixtures/libreoffice/csi-spec-sample.docx'));

    // Import (O-8) → spec lands at 'review' with paragraphs + source_facts.
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(docx)], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      'sample.docx'
    );
    const imp = await fetch(`${baseUrl}/libraries/${lib.id}/import`, { method: 'POST', body: form });
    expect(imp.status).toBe(202);
    const jobId = ((await imp.json()) as { data: { jobId: string } }).data.jobId;
    let specId = '';
    for (let i = 0; i < 100; i++) {
      const j = await fetch(`${baseUrl}/libraries/import/jobs/${jobId}`);
      const jb = (await j.json()) as { data: { status: string; result?: { specId: string } } };
      if (jb.data.status === 'complete') {
        specId = jb.data.result?.specId ?? '';
        break;
      }
      if (jb.data.status === 'failed') throw new Error('import failed');
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(specId).not.toBe('');

    // Finalize → active.
    const fin = await fetch(`${baseUrl}/specs/${specId}/finalize`, { method: 'POST' });
    expect(fin.status).toBe(200);

    // #136 reclassify still works on the active spec.
    const recl = await fetch(`${baseUrl}/specs/${specId}/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview: true }),
    });
    expect(recl.status).toBe(200);

    // #137 library conventions still writable.
    const conv = await fetch(`${baseUrl}/libraries/${lib.id}/conventions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Flex', rules: {} }),
    });
    expect(conv.status).toBe(200);

    // #138 style-source still clearable on the active spec.
    const clear = await fetch(`${baseUrl}/specs/${specId}/style-source`, { method: 'DELETE' });
    expect([200, 404]).toContain(clear.status); // 404 only if no source was set
  }, 60_000);
});
```

Cleanup: the `lib-fapi-%` afterEach already drops these libraries' specs + conventions. Add style_template cleanup if the import derived one — extend afterEach to drop orphaned templates the same way `onboarding.integration.test.ts` does (capture style_template_id before deleting specs).

- [ ] **Step 2: Update afterEach to clean derived templates** — replace the afterEach in the test file:

```typescript
afterEach(async () => {
  const templates = await pool.query<{ style_template_id: string }>(
    `SELECT style_template_id FROM specs
     WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fapi-%')
       AND style_template_id IS NOT NULL`
  );
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fapi-%')`
  );
  for (const row of templates.rows) {
    await pool.query(`DELETE FROM style_templates WHERE id = $1`, [row.style_template_id]);
  }
  await pool.query(
    `DELETE FROM editing_conventions WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fapi-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lib-fapi-%'`);
});
```

- [ ] **Step 3: Run, verify pass** — Run: `pnpm test:integration -- onboarding-status.integration` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/api/onboarding-status.integration.test.ts
git commit -m "test(api): flexibility regression — loop endpoints work on active spec"
```

---

### Task 7: Full gate + finish

- [ ] **Step 1: Lint** — Run: `pnpm lint` → clean (eslint + tsc --noEmit + prettier --check).
- [ ] **Step 2: Unit tests** — Run: `pnpm test` → green.
- [ ] **Step 3: Migration round-trip** — Run: `pnpm migrate && pnpm migrate:down && pnpm migrate` → clean.
- [ ] **Step 4: Full integration suite** — Run: `pnpm migrate && pnpm seed && pnpm test:integration` → green (esp. contract + new finalize/reopen + flexibility).
- [ ] **Step 5: Finish the branch** — use superpowers:finishing-a-development-branch, option 2 (Push + PR). PR body: Closes #139, Why/What, Design decisions, Testing checklist; credit Claude Opus 4.8.

## Self-Review

**Spec coverage:**
- Migration up/down clean, O-8 → review, existing → active → Task 1 + Task 2 Step 5.
- finalize persists conventions to library profile + flips status; reopen flips back → Task 2 (queries), Task 3 (API).
- Loop endpoints functional on active (flexibility regression) → Task 6.
- finalize on already-active → idempotent no-op (pinned) → Task 2 + Task 3 tests.
- Surface status on GET /specs/:id + MCP get_spec → Task 4.
- openapi.yaml + contract gate → Task 5.

**Design decisions documented for PR:**
- Idempotent no-op (200) chosen over 409 for finalize-on-active — finalize is a state assertion, not a create; idempotency is friendlier to retries. Pinned by test.
- Snapshot semantics: `getConventionForLibrary` resolves (library-own OR built-in default) and `upsertLibraryConvention` writes it under the library → after finalize the library OWNS a profile (future imports stop falling back to the built-in). Re-finalize is harmless (idempotent upsert).
- Re-import (ON CONFLICT) does NOT reset onboarding_status — a human's finalize stands; only brand-new rows land at `review`.
- No request body on finalize/reopen — pure path-param state transitions; spec id validated with `z.uuid()`.
