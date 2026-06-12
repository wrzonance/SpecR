# Package Revisions — Immutable Issuance Snapshots (issue #96, ADR-015 D5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issuing a package revision (`POST /packages/:id/revisions { label }`) freezes every member section's full `SpecTree` as JSONB; `GET /revisions/:id` returns the frozen trees, Zod-validated on read — a reproducible, liability-grade record of exactly what was issued.

**Architecture:** New migration 021 creates `package_revisions` + `package_revision_specs` exactly per ADR-015 D5. A new query module `src/db/queries/revisions.ts` snapshots inside one `REPEATABLE READ` transaction (consistent point-in-time view across all member specs), validating each tree against `SpecTreeSchema` at write AND read. API handlers in `src/api/revisions.ts` follow the packages.ts pattern (typed errors → status codes via `pgErrorToHttp`).

**Tech Stack:** TypeScript/Node 22, Express 5, Zod v4, pg, node-pg-migrate, vitest integration tests against real Postgres.

**Design decisions (documented for PR body):**
1. `package_revision_specs.spec_id` uses the FK default (NO ACTION), exactly as ADR-015 D5 writes it — checked at end of statement so project-delete cascades stay safe, while ad-hoc spec deletion under a revision is blocked (custody).
2. Snapshot trees are validated at **write** as well as read — never freeze a snapshot that cannot round-trip (fails issuance with 422).
3. `BEGIN ISOLATION LEVEL REPEATABLE READ` for the snapshot transaction — all member trees come from one consistent DB snapshot.
4. Issuing an **empty package** is allowed (`specCount: 0`) — the revision record itself is still meaningful; rejecting would be policy not data integrity.
5. `POST` returns a summary (`specCount`), not the full trees — trees can be large; `GET /revisions/:id` is the read surface.
6. `lifecycle_state='issued'` hook deliberately NOT implemented (ADR-018, deferred per issue).

---

### Task 1: Migration 021 — `package_revisions` + `package_revision_specs`

**Files:**
- Create: `src/db/migrations/021_create_package_revisions.ts`

- [ ] Step 1: Write migration (up: both tables, UNIQUE (package_id, label), PK (revision_id, spec_id), position >= 1 check; down: drop both)
- [ ] Step 2: `DATABASE_URL=... pnpm migrate` → applies cleanly
- [ ] Step 3: `DATABASE_URL=... pnpm migrate:down` → rolls back cleanly; re-apply with `pnpm migrate`
- [ ] Step 4: Commit `feat(db): package_revisions + package_revision_specs tables (ADR-015 D5)`

### Task 2: Failing integration tests (API boundary)

**Files:**
- Create: `src/api/revisions.integration.test.ts`

Tests (mirror `packages.integration.test.ts` setup: company library, master specs **with paragraph trees** via `insertTree`, project derived from masters, package with ordered membership):
- [ ] POST creates revision: 201, `{ revisionId, packageId, label, issuedAt, specCount }`
- [ ] GET returns frozen trees in position order; every `tree` re-validates with `SpecTreeSchema.parse` (acceptance: round-trip)
- [ ] Immutability: UPDATE a paragraph's text after issuance → GET still returns the pre-edit text (acceptance)
- [ ] Duplicate label in same package → 409 (acceptance: UNIQUE)
- [ ] Same label on a different package → 201 (uniqueness is package-scoped)
- [ ] Empty package issues with `specCount: 0`
- [ ] 404 unknown package (POST), 404 unknown revision (GET), 422 empty label
- [ ] DELETE package cascades its revisions + snapshot rows
- [ ] Step: run `pnpm test:integration` → new tests FAIL (404 route not found)

### Task 3: Query module `src/db/queries/revisions.ts`

**Files:**
- Create: `src/db/queries/revisions.ts`
- Modify: `src/db/queries/specs.ts` (export `buildNodeTree` for intra-module reuse)
- Modify: `src/db/index.ts` (barrel exports)

- [ ] `createPackageRevision(packageId, label, db)` — REPEATABLE READ txn: lock package FOR UPDATE (else `PackageNotFoundError`), insert revision row, read ordered membership, build + Zod-validate each tree (else `SnapshotValidationError`), insert `package_revision_specs` rows, COMMIT
- [ ] `getPackageRevision(revisionId, db)` — null when unknown; Zod-validate each stored tree on read (else `SnapshotValidationError`)
- [ ] Errors: `SnapshotValidationError extends DatabaseError`; reuse `PackageNotFoundError` from packages.ts

### Task 4: API handlers + schema + router

**Files:**
- Create: `src/api/revisions.ts`
- Modify: `src/ast/schemas.ts` (`CreateRevisionBodySchema`), `src/ast/index.ts`, `src/api/router.ts`

- [ ] `createRevisionHandler`: 201 / 404 (`PackageNotFoundError`) / 409 (23505 via `pgErrorToHttp`) / 422 (`SnapshotValidationError`) / 500
- [ ] `getRevisionHandler`: 200 / 404 (null) / 500 (`SnapshotValidationError` on read = integrity failure) / 500
- [ ] Routes: `POST /packages/:id/revisions` (validateBody), `GET /revisions/:id`
- [ ] Run `pnpm test:integration` → all PASS; `pnpm lint && pnpm test` green
- [ ] Commit `feat(api): package revisions — immutable issuance snapshots (ADR-015 D5)`

### Task 5: openapi.yaml + verification

- [ ] Add `/packages/{id}/revisions` (post) and `/revisions/{id}` (get) paths + `RevisionSummary`, `RevisionWithTrees`, `RevisionSpecEntry` component schemas (reuse `SpecTree`)
- [ ] Full verification: `pnpm lint && pnpm test` and migrate→seed→test:integration on the isolated PG (port 5445); test `pnpm migrate:down` rollback
- [ ] Commit `docs(api): openapi paths for package revisions`
