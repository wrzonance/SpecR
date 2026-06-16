# Document Concurrency Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. TDD throughout.

**Goal:** Add optimistic version preconditions on content writes, advisory TTL locks, a native lifecycle state, and a composed (native AND external) edit gate — ADR-018.

**Architecture:** `specs.content_version` (ADR-015) is the optimistic version. Content writes (PATCH paragraph, merge) carry `expectedVersion`; a mismatch → 409 with the current version. A new `spec_locks` table gives advisory soft locks with TTL + steal-after-expiry. `specs.lifecycle_state` (draft|issued|archived) plus `specs.external_state` (ADR-014 D5 generic enum) compose into one edit gate: a write requires lifecycle writable (not archived) AND external writable (editable). `createPackageRevision` flips member specs to `issued`.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, node-pg-migrate, PostgreSQL, vitest.

---

## Task 1: Migration 025 — lifecycle_state, external_state, spec_locks

**Files:**
- Create: `src/db/migrations/025_document_concurrency.ts`

- [ ] Add `specs.lifecycle_state` text NOT NULL DEFAULT 'draft' + CHECK in ('draft','issued','archived').
- [ ] Add `specs.external_state` text NOT NULL DEFAULT 'editable' + CHECK in ('editable','locked','pending-review','retained','read-only') — the single generic field ADR-018 D3's gate reads; populated later by the Phase-7 connector (ADR-014 D5).
- [ ] Create `spec_locks` (spec_id PK FK→specs ON DELETE CASCADE, holder text NOT NULL, acquired_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL).
- [ ] Reversible `down`: drop table, drop columns + constraints.
- [ ] Verify: `pnpm migrate && pnpm migrate:down && pnpm migrate`.

## Task 2: Lock queries (`src/db/queries/locks.ts`)

**Files:**
- Create: `src/db/queries/locks.ts`, `src/db/queries/locks.integration.test.ts`
- Modify: `src/db/index.ts` (barrel export)

API:
- `acquireLock(specId, holder, ttlSeconds)` → `{ status:'acquired', lock } | { status:'held', holder, expiresAt }`. Acquires when no row, OR holder matches (refresh), OR existing row is expired (steal). Single UPSERT under row lock.
- `releaseLock(specId, holder)` → `{ released: boolean }` (only the holder may release; expired/foreign → false).
- `getLock(specId)` → `LockState | null` (null when none or expired).
- TTL default constant `DEFAULT_LOCK_TTL_SECONDS = 900` (15 min).

- [ ] Test: acquire on free spec → acquired.
- [ ] Test: second different holder while live → held (with first holder in result).
- [ ] Test: same holder re-acquire → acquired (refreshes expires_at).
- [ ] Test: second holder after expiry → acquired (steal).
- [ ] Test: release by non-holder → released:false; by holder → true.

## Task 3: Edit-gate query (`src/db/queries/edit-gate.ts`)

**Files:**
- Create: `src/db/queries/edit-gate.ts`, `.integration.test.ts`
- Modify: `src/db/index.ts`

- `assertSpecWritable(db, specId)` → throws `SpecWriteForbiddenError` (extends DatabaseError) when lifecycle_state='archived' OR external_state not in ('editable'). Returns `{ contentVersion }` when writable + accepts an optional `expectedVersion` → throws `StaleVersionError` (carries `currentVersion`) on mismatch. Reads `SELECT lifecycle_state, external_state, content_version FROM specs WHERE id=$1 FOR UPDATE`. Returns sentinel/throws `SpecNotFoundError` when no row.

- [ ] Test: archived spec → SpecWriteForbiddenError.
- [ ] Test: external_state='locked' → SpecWriteForbiddenError.
- [ ] Test: draft + editable, expectedVersion matches → ok.
- [ ] Test: stale expectedVersion → StaleVersionError with currentVersion.

## Task 4: Wire precondition + gate into paragraph PATCH

**Files:**
- Modify: `src/ast/schemas.ts` (UpdateParagraphBodySchema += expectedVersion), `src/db/queries/paragraphs.ts` (updateParagraphText calls gate, bumps specs.content_version), `src/api/paragraphs.ts` (map StaleVersionError→409, forbidden→409).

- [ ] Test (integration): stale version PATCH → 409 with current version in body.
- [ ] Test: archived spec PATCH → 409/403 forbidden.
- [ ] Test: matching version PATCH → 200 and content_version increments.

## Task 5: Wire precondition + gate into merge

**Files:**
- Modify: `src/api/merge.ts` (MergeBodySchema += optional expectedVersion; gate + version check inside the txn; bump content_version on success).

- [ ] Test (integration): merge with stale version → 409.
- [ ] Test: merge on archived spec → 409.

## Task 6: Issuance hook — createPackageRevision flips lifecycle to issued

**Files:**
- Modify: `src/db/queries/revisions.ts` (after snapshot insert, UPDATE specs SET lifecycle_state='issued' for member spec_ids where lifecycle_state='draft').

- [ ] Test (integration): issuing a revision sets member specs.lifecycle_state='issued'; already-archived specs unaffected.

## Task 7: Lock REST endpoints

**Files:**
- Create: `src/api/locks.ts`, `src/api/locks.integration.test.ts`
- Modify: `src/api/router.ts`, `src/ast/schemas.ts` (AcquireLockBodySchema).

- PUT `/specs/:id/lock` (body: holder, ttlSeconds?) → 200 acquired | 409 held(holder).
- DELETE `/specs/:id/lock` (body: holder) → 200 released | 409 not-holder.
- GET `/specs/:id/lock` → 200 {locked, holder?, expiresAt?}.

- [ ] Test: full acquire/held/release cycle over REST.

## Task 8: openapi.yaml + ADR note

**Files:**
- Modify: `openapi.yaml` (expectedVersion on paragraph PATCH + merge; 409 stale/forbidden; lock endpoints; lifecycle_state in spec schema).
- Modify: `docs/adr/018-document-concurrency-state-model.md` (Status → Accepted; note external_state column added here, populated in Phase 7).

- [ ] `pnpm lint` green, `pnpm test` + `pnpm test:integration` green.
</content>
</invoke>
