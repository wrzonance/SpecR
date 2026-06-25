# Paragraph Removal Lifecycle (vanish vs delete) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reversible paragraph-removal lifecycle action to the editability program — set/clear `meta.vanish` on a paragraph through the existing edit gate, instead of a hard cascading DELETE.

**Architecture:** A new dedicated sub-route `PATCH /specs/:id/paragraphs/:nodeId/removal` with body `{ removed: boolean }`. `removed: true` sets `paragraphs.vanish = true` (suppress render, keep the row + subtree + refs); `removed: false` clears it (reversible un-vanish). The write passes `assertSpecWritable` (the composed ADR-018 edit gate) and an ownership check (the `(specId, nodeId)` pairing), mirroring `updateParagraphText` and `setSpecEditabilityOverride`. The `paragraphs.vanish` column already exists (migration 003) and the markdown renderer already suppresses vanish nodes without disturbing CSI ordinals — so NO migration and NO renderer change is needed.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, PostgreSQL (pg), vitest.

## Global Constraints

- ESM project (`"type": "module"`): relative imports use `.js` extensions; `verbatimModuleSyntax` requires `import type` for type-only imports.
- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, `no-console` = error, `@typescript-eslint/no-explicit-any` = error. No `any` / `as unknown as` / non-null `!` outside tests.
- Module boundaries HARD: import only from a sibling's `index.ts` barrel (`../db/index.js`, `../ast/index.js`), never its internals.
- Typed errors extend `SpecrError`/`DatabaseError` and chain `cause`. Validate external input with Zod. No `console.*` in `src/` — use `src/lib/logger.ts`.
- `openapi.yaml` is the CI-enforced contract — every endpoint change updates it in the same PR. The contract gate (`src/api/contract.integration.test.ts`) checks bidirectional route↔spec coverage + response-schema validation.
- Use `z.uuid()` (Zod v4), not `z.string().uuid()`.
- Conventional Commits, scope = module changed. End every commit with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Build-green gate: `pnpm lint` + `pnpm test` (unit) must pass; `pnpm test:integration` for the new integration test. Run with `DATABASE_URL=postgres://specr:specr@localhost:5432/specr` set.

---

### Task 1: DB layer — `setParagraphVanish`

Add a spec-scoped, edit-gated function that sets or clears `paragraphs.vanish` for one node, returning an ownership-checked outcome. It belongs in `src/db/queries/paragraphs.ts` (the home of `updateParagraphText`), reusing the same transaction + edit-gate + ownership shape.

**Files:**
- Modify: `src/db/queries/paragraphs.ts` (add `setParagraphVanish` + `SetVanishResult` near `updateParagraphText`)
- Modify: `src/db/index.ts` (re-export the new function + type from the barrel)
- Test: `src/db/queries/paragraphs.integration.test.ts` (create if absent; else append)

**Interfaces:**
- Consumes: `assertSpecWritable(client, specId)` from `./edit-gate.js`; `pool`, `DatabaseError` from `../index.js`; `fetchSubtreeNode` (already in this file).
- Produces:
  - `type SetVanishResult = { status: 'updated'; node: SpecNode } | { status: 'not-found' } | { status: 'wrong-spec' }`
  - `setParagraphVanish(specId: string, nodeId: string, vanish: boolean): Promise<SetVanishResult>`

- [ ] **Step 1: Write the failing test**

Append to `src/db/queries/paragraphs.integration.test.ts` (create the file with the harness below if it does not exist; model the seed on `src/api/editability.integration.test.ts` lines 61–96):

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, setParagraphVanish } from '../index.js';

let specId: string;
let nodeId: string;
let otherSpecId: string;

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
  );
  const libraryId = lib.rows[0]!.id;
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('99 99 81', 'Vanish DB Test', 'arcat', $1) RETURNING id`,
    [libraryId]
  );
  specId = spec.rows[0]!.id;
  const node = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, NULL, 'pr1', 'Removable paragraph.', 1) RETURNING id`,
    [specId]
  );
  nodeId = node.rows[0]!.id;
  const other = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('99 99 80', 'Vanish DB Other', 'arcat', $1) RETURNING id`,
    [libraryId]
  );
  otherSpecId = other.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [[specId, otherSpecId]]);
});

describe('setParagraphVanish', () => {
  it('vanishes a paragraph (reversible removal), returning the updated node', async () => {
    const r = await setParagraphVanish(specId, nodeId, true);
    expect(r.status).toBe('updated');
    if (r.status === 'updated') expect(r.node.meta.vanish).toBe(true);
    const row = await pool.query<{ vanish: boolean }>(
      `SELECT vanish FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(row.rows[0]!.vanish).toBe(true);
  });

  it('un-vanishes a paragraph (reverses removal)', async () => {
    await setParagraphVanish(specId, nodeId, true);
    const r = await setParagraphVanish(specId, nodeId, false);
    expect(r.status).toBe('updated');
    if (r.status === 'updated') expect(r.node.meta.vanish).toBeUndefined();
  });

  it('returns not-found for an unknown node', async () => {
    const r = await setParagraphVanish(specId, '00000000-0000-0000-0000-000000000000', true);
    expect(r.status).toBe('not-found');
  });

  it('returns wrong-spec when the node belongs to another spec', async () => {
    const r = await setParagraphVanish(otherSpecId, nodeId, true);
    expect(r.status).toBe('wrong-spec');
  });

  it('bumps specs.content_version on a successful vanish', async () => {
    const before = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    await setParagraphVanish(specId, nodeId, true);
    const after = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    expect(after.rows[0]!.content_version).toBeGreaterThan(before.rows[0]!.content_version);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project integration src/db/queries/paragraphs.integration.test.ts`
Expected: FAIL — `setParagraphVanish` is not exported from `../index.js`.

- [ ] **Step 3: Write the minimal implementation**

In `src/db/queries/paragraphs.ts`, add after `updateParagraphText` (reuse `fetchSubtreeNode`, `assertSpecWritable`, the BEGIN/COMMIT pattern). Keep each function ≤50 lines — split the in-transaction body out as `applyVanish`, exactly like `applyParagraphUpdate`:

```typescript
/** Outcome of {@link setParagraphVanish}: the (specId, nodeId) pairing is
 *  validated before the write so the API maps `not-found` → 404 and
 *  `wrong-spec` → 403 (mirrors updateParagraphText). */
export type SetVanishResult =
  | { readonly status: 'updated'; readonly node: SpecNode }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' };

// In-transaction body of setParagraphVanish: gate → ownership → write vanish +
// bump specs.content_version. Caller commits on 'updated', rolls back otherwise.
async function applyVanish(
  client: PoolClient,
  specId: string,
  nodeId: string,
  vanish: boolean
): Promise<SetVanishResult> {
  await assertSpecWritable(client, specId);

  const owner = await client.query<{ spec_id: string }>(
    `SELECT spec_id FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [nodeId]
  );
  const ownerRow = owner.rows[0];
  if (!ownerRow) return { status: 'not-found' };
  if (ownerRow.spec_id !== specId) return { status: 'wrong-spec' };

  await client.query(
    `UPDATE paragraphs SET vanish = $2, base_version = base_version + 1, updated_at = now()
     WHERE id = $1`,
    [nodeId, vanish]
  );
  await client.query(
    `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
    [specId]
  );

  const node = await fetchSubtreeNode(client, specId, nodeId);
  if (!node) throw new DatabaseError('setParagraphVanish: updated node vanished mid-transaction');
  return { status: 'updated', node };
}

/**
 * Set or clear a paragraph's `vanish` flag by UUID — the editability program's
 * reversible removal (#251, ADR-022). `vanish: true` suppresses the node from
 * every render while keeping the row, its subtree, and contained refs intact;
 * `false` reverses it. Passes the composed edit gate (ADR-018) and verifies the
 * (specId, nodeId) pairing under a row lock, so removal is authorized exactly
 * like any other content write.
 */
export async function setParagraphVanish(
  specId: string,
  nodeId: string,
  vanish: boolean
): Promise<SetVanishResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyVanish(client, specId, nodeId, vanish);
    await client.query(result.status === 'updated' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('setParagraphVanish failed', { cause: err });
  } finally {
    client.release();
  }
}
```

Then in `src/db/index.ts`, add `setParagraphVanish` to the `./queries/paragraphs.js` value re-export and `SetVanishResult` to its `export type` re-export (find the existing `updateParagraphText` / `UpdateParagraphResult` re-export block and extend it).

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project integration src/db/queries/paragraphs.integration.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/paragraphs.ts src/db/index.ts src/db/queries/paragraphs.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): setParagraphVanish — edit-gated reversible paragraph removal (#251)

Sets/clears paragraphs.vanish through the composed edit gate + ownership
check, mirroring updateParagraphText. No migration: the vanish column and
renderer suppression already exist.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: AST schema — `PatchRemovalBodySchema`

Add the request-body schema beside the other editability bodies in `src/ast/schemas.ts` and export it from the barrel.

**Files:**
- Modify: `src/ast/schemas.ts` (add `PatchRemovalBodySchema` + type near `PatchEditabilityBodySchema`, ~line 175)
- Modify: `src/ast/index.ts` (re-export the schema value + type)
- Test: `src/ast/schemas.test.ts` (append; this unit test needs no DB)

**Interfaces:**
- Produces:
  - `PatchRemovalBodySchema` — `z.object({ removed: z.boolean() })`
  - `type PatchRemovalBody = z.infer<typeof PatchRemovalBodySchema>`

- [ ] **Step 1: Write the failing test**

Append to `src/ast/schemas.test.ts` (match the file's existing import style — import `PatchRemovalBodySchema` from `'./index.js'`):

```typescript
import { PatchRemovalBodySchema } from './index.js';

describe('PatchRemovalBodySchema', () => {
  it('accepts { removed: true }', () => {
    expect(PatchRemovalBodySchema.parse({ removed: true })).toEqual({ removed: true });
  });
  it('accepts { removed: false } (un-vanish)', () => {
    expect(PatchRemovalBodySchema.parse({ removed: false })).toEqual({ removed: false });
  });
  it('rejects a missing removed flag', () => {
    expect(PatchRemovalBodySchema.safeParse({}).success).toBe(false);
  });
  it('rejects a non-boolean removed flag', () => {
    expect(PatchRemovalBodySchema.safeParse({ removed: 'yes' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project unit src/ast/schemas.test.ts`
Expected: FAIL — `PatchRemovalBodySchema` is not exported.

- [ ] **Step 3: Write the minimal implementation**

In `src/ast/schemas.ts`, after `PatchEditabilityBodySchema` / its type (~line 179):

```typescript
// #251 — reversible paragraph removal. `removed: true` sets meta.vanish (suppress
// render, keep the row + subtree + refs); `false` reverses it. Distinct from a
// hard DELETE by design (ADR-022, symmetric with ADR-030 spec soft-delete).
export const PatchRemovalBodySchema = z.object({
  removed: z.boolean(),
});

export type PatchRemovalBody = z.infer<typeof PatchRemovalBodySchema>;
```

In `src/ast/index.ts`, add `PatchRemovalBodySchema` to the schema value re-export and `PatchRemovalBody` to the `export type` re-export from `./schemas.js` (extend the block that already re-exports `PatchEditabilityBodySchema` / `PatchEditabilityBody`).

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project unit src/ast/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ast/schemas.ts src/ast/index.ts src/ast/schemas.test.ts
git commit -m "$(cat <<'EOF'
feat(ast): PatchRemovalBodySchema — { removed: boolean } for paragraph removal (#251)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: API handler + route — `PATCH /specs/:id/paragraphs/:nodeId/removal`

Add the handler in `src/api/paragraphs.ts` (home of `updateParagraphHandler`) and register the route. Map `not-found` → 404, `wrong-spec` → 403, edit-gate errors via `gateErrorResponse` (archived/locked → 409, stale not applicable — no `expectedVersion`), success → 200 with the updated node.

**Files:**
- Modify: `src/api/paragraphs.ts` (add `removeParagraphHandler`)
- Modify: `src/api/router.ts` (register the route; import the handler)
- Test: `src/api/editability.integration.test.ts` (append a `describe` block; the harness, `req`, `findNode`, `specId`, `nodeId`, `otherSpecId` already exist there)

**Interfaces:**
- Consumes: `setParagraphVanish`, `SetVanishResult` from `../db/index.js`; `PatchRemovalBodySchema` from `../ast/index.js`; `gateErrorResponse` from `./edit-gate-response.js`; `logger` from `../lib/logger.js`.
- Produces: `removeParagraphHandler(req, res): Promise<void>` and the registered route.

- [ ] **Step 1: Write the failing test**

Append to `src/api/editability.integration.test.ts` (after the editability `describe` block, before `afterAll` runs — it is fine anywhere among the top-level `describe`s; reuse the existing `findNode` import-shape and `req`):

```typescript
describe('PATCH /specs/:id/paragraphs/:nodeId/removal', () => {
  it('removes a paragraph via vanish and returns 200 with vanish:true', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/removal`, {
      removed: true,
    });
    expect(r.status).toBe(200);
    expect((r.body as { success: boolean }).success).toBe(true);
    expect((r.body as { data: { meta: { vanish?: boolean } } }).data.meta.vanish).toBe(true);
  });

  it('reverses removal (un-vanish) with removed:false', async () => {
    await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/removal`, { removed: true });
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/removal`, {
      removed: false,
    });
    expect(r.status).toBe(200);
    expect((r.body as { data: { meta: { vanish?: boolean } } }).data.meta.vanish).toBeUndefined();
  });

  it('rejects a non-boolean removed flag with 400', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/removal`, {
      removed: 'yes',
    });
    expect(r.status).toBe(400);
  });

  it('404 for an unknown node', async () => {
    const r = await req(
      'PATCH',
      `/specs/${specId}/paragraphs/00000000-0000-0000-0000-000000000000/removal`,
      { removed: true }
    );
    expect(r.status).toBe(404);
  });

  it('403 when the node belongs to another spec', async () => {
    const r = await req('PATCH', `/specs/${otherSpecId}/paragraphs/${nodeId}/removal`, {
      removed: true,
    });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project integration src/api/editability.integration.test.ts`
Expected: FAIL — route returns 404 (Express default) for an unrouted path, so the success and 400/403 cases fail.

- [ ] **Step 3: Write the minimal implementation**

In `src/api/paragraphs.ts`, add (reuse the existing UUID-parsing pattern from `updateParagraphHandler`; keep ≤50 lines):

```typescript
import { PatchRemovalBodySchema } from '../ast/index.js';
import { setParagraphVanish } from '../db/index.js';
```

(merge those into the existing import lines — `UpdateParagraphBodySchema` is already imported from `../ast/index.js`; `updateParagraphText` from `../db/index.js`.)

```typescript
/**
 * PATCH /specs/:id/paragraphs/:nodeId/removal — the editability program's
 * reversible removal (#251, ADR-022). `{ removed: true }` sets `meta.vanish`
 * (suppress render, keep the row + subtree + contained refs); `false` reverses
 * it. Passes the composed edit gate (ADR-018): archived/upstream-locked → 409.
 * A separate sub-route from the text-replacement PATCH — removal is a lifecycle
 * action, not a text edit, and must not require a non-empty `text`.
 */
export async function removeParagraphHandler(req: Request, res: Response): Promise<void> {
  const specId = z.uuid().safeParse(req.params['id']);
  if (!specId.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const nodeId = z.uuid().safeParse(req.params['nodeId']);
  if (!nodeId.success) {
    res.status(400).json({ success: false, error: 'invalid node id' });
    return;
  }
  const body = PatchRemovalBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: 'removed must be a boolean' });
    return;
  }

  try {
    const result = await setParagraphVanish(specId.data, nodeId.data, body.data.removed);
    switch (result.status) {
      case 'not-found':
        res.status(404).json({ success: false, error: 'paragraph not found' });
        return;
      case 'wrong-spec':
        res.status(403).json({ success: false, error: 'paragraph does not belong to this spec' });
        return;
      case 'updated':
        res.status(200).json({ success: true, data: result.node });
        return;
    }
  } catch (err) {
    const gate = gateErrorResponse(err);
    if (gate) {
      res.status(gate.status).json(gate.body);
      return;
    }
    logger.error({ err }, 'remove paragraph failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}
```

In `src/api/router.ts`, extend the existing import and register the route right after the text PATCH (line ~115):

```typescript
import { updateParagraphHandler, removeParagraphHandler } from './paragraphs.js';
```

```typescript
router.patch('/specs/:id/paragraphs/:nodeId/removal', removeParagraphHandler);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project integration src/api/editability.integration.test.ts`
Expected: PASS (all 5 new cases + the pre-existing editability cases).

- [ ] **Step 5: Commit**

```bash
git add src/api/paragraphs.ts src/api/router.ts src/api/editability.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(api): PATCH /specs/:id/paragraphs/:nodeId/removal — reversible vanish (#251)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: OpenAPI contract + contract-gate registration

Document the new operation in `openapi.yaml` and register it in the contract test's `RESPONSE_ALLOWLIST` so the bidirectional route↔spec gate stays green.

**Files:**
- Modify: `openapi.yaml` (add the `patch` op under a new `/specs/{id}/paragraphs/{nodeId}/removal` path)
- Modify: `src/api/contract.integration.test.ts` (add `'patch /specs/{}/paragraphs/{}/removal'` to `RESPONSE_ALLOWLIST`, ~line 57)

**Interfaces:**
- Consumes: the route registered in Task 3.

- [ ] **Step 1: Run the contract gate to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project integration src/api/contract.integration.test.ts`
Expected: FAIL — the new route is undocumented (route present in Express manifest, absent from the spec).

- [ ] **Step 2: Add the OpenAPI path**

In `openapi.yaml`, add immediately after the `/specs/{id}/paragraphs/{nodeId}/editability` block (it ends ~line 321, before `/specs/{id}/reclassify`):

```yaml
  /specs/{id}/paragraphs/{nodeId}/removal:
    patch:
      operationId: removeParagraph
      summary: Remove or restore a paragraph (reversible soft removal)
      description: >
        The editability program's reversible paragraph removal (#251, ADR-022).
        `removed: true` sets the node's `vanish` flag — it is suppressed from
        every render while the row, its subtree, and any contained cross-references
        stay intact; `removed: false` reverses it. This is a soft, reversible
        removal by design (symmetric with the spec soft-delete in ADR-030), not a
        hard cascading DELETE. The node must belong to the spec in the path (else
        403). The composed edit gate (ADR-018) rejects an archived spec or one
        locked upstream in a DMS (409).
      tags: [specs]
      parameters:
        - $ref: '#/components/parameters/SpecId'
        - $ref: '#/components/parameters/NodeId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [removed]
              properties:
                removed:
                  type: boolean
                  description: >
                    true to remove (set vanish), false to restore (clear vanish).
      responses:
        '200':
          description: Updated paragraph node (with its subtree)
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        $ref: '#/components/schemas/SpecNode'
        '400':
          $ref: '#/components/responses/BadRequest'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '409':
          $ref: '#/components/responses/WriteConflict'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

- [ ] **Step 3: Register in the contract gate allowlist**

In `src/api/contract.integration.test.ts`, in `RESPONSE_ALLOWLIST`, add after `'patch /specs/{}/paragraphs/{}'` (line 57):

```typescript
  'patch /specs/{}/paragraphs/{}/removal',
```

- [ ] **Step 4: Run the contract gate to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project integration src/api/contract.integration.test.ts`
Expected: PASS — route documented, operation routed, response schema matches.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/api/contract.integration.test.ts
git commit -m "$(cat <<'EOF'
docs(openapi): document PATCH /specs/:id/paragraphs/:nodeId/removal (#251)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Full build-green gate + review

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: PASS (eslint + tsc --noEmit + prettier --check). If prettier complains, run `pnpm format` and amend the relevant commit.

- [ ] **Step 2: Unit tests**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr pnpm test`
Expected: PASS.

- [ ] **Step 3: Integration tests (the new + touched suites)**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr npx vitest run --project integration src/db/queries/paragraphs.integration.test.ts editability.integration contract.integration`
Expected: PASS.

- [ ] **Step 4: Code review**

Use superpowers:requesting-code-review (or the `code-review` skill) over the branch diff. Address CRITICAL/HIGH before finishing.

---

## Self-Review

**1. Spec coverage (issue #251 + design §6 D):**
- "Removal via `meta.vanish` through the editability lifecycle" → Tasks 1–3.
- "Reversible (un-vanish) must be supported" → `removed: false` path, tested in Tasks 1 & 3.
- "Respect the same authorization as other edits (edit-gate checks)" → `assertSpecWritable` in Task 1, `gateErrorResponse` → 409 in Task 3.
- "Surface it cleanly … follow the existing PATCH/reclassify/accept-as-note patterns" → dedicated sub-route mirroring `/editability`, Task 3.
- "Update openapi.yaml in the same PR" → Task 4.
- "Note whether the demo flag is safe to flip" → covered in the PR body (the demo's `DELETE`-with-cascade differs from vanish; flag stays false pending a demo-side switch). No code task — it's a deferred demo change, documented.

**2. Placeholder scan:** No TBD/TODO/"add validation"/"similar to Task N" — every code step shows full code. ✓

**3. Type consistency:** `SetVanishResult` (Task 1) consumed by `removeParagraphHandler` (Task 3) with matching `status` literals (`'updated' | 'not-found' | 'wrong-spec'`) and `node: SpecNode`. `PatchRemovalBodySchema` / `removed: boolean` consistent across Tasks 2–4. `setParagraphVanish(specId, nodeId, vanish)` signature stable. ✓

## Design decisions (carried to the PR body)

- **Dedicated sub-route, not body-overload.** `PATCH .../paragraphs/:nodeId` requires non-empty `text` and is text-replacement-shaped; removal is a lifecycle action. A `/removal` sub-route matches the existing `/editability` and `/accept-as-note` action sub-routes and keeps both contracts clean.
- **`{ removed: boolean }`, not separate verbs.** One reversible toggle (true/false) over two endpoints — clearest expression of a reversible state, mirrors `PatchEditabilityBodySchema`'s set-or-clear-in-one-call ethos.
- **No `expectedVersion` in v1.** Removal is a single-field idempotent toggle; optimistic concurrency can be added later if the UI needs it. The edit gate still runs (lifecycle/external state).
- **No migration, no renderer change.** `paragraphs.vanish` exists (mig 003) and the renderer already suppresses vanish nodes without shifting CSI ordinals (`consumesNumber`). The lifecycle was the only missing piece.
- **Demo flag deferred.** `paragraphDelete=false` stays until a demo-side change swaps `DELETE`-with-cascade for the vanish PATCH and updates the confirm copy (it currently warns about deleting nested items + refs, which vanish does NOT do).
