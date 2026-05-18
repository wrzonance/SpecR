# csi_sections → spec_sections DB Rename + Issue Body Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the trademark good-faith pass by (1) renaming the `csi_sections` PostgreSQL table to `spec_sections` (deferred Phase C3 from spec `2026-05-18-trademark-good-faith.md`) and (2) sweeping any remaining stale identifier references from open GitHub issue bodies that escaped the type rename in PR #78.

**Architecture:** Single PR. One migration file plus 5 SQL-string updates in src/, plus an `ALTER INDEX` for the supporting `csi_sections_division_index`. Issue body updates already shipped via `gh issue edit` against issues #39, #44, #47, #53 prior to the migration work.

**Tech Stack:** PostgreSQL 16, node-pg-migrate, vitest integration tests.

**Out of scope:**
- Renaming primary-key / unique-constraint internal names (e.g. `csi_sections_pkey`). Postgres auto-derives these; they're transparent to application code and have zero trademark surface. Leave for a future tidiness pass if ever needed.
- Renaming historical plan files (`docs/superpowers/plans/*`) — those are execution records, immutable.
- Renaming the `csi` substring inside ADR-013's filename (`013-csi-sections-seed-public-domain-derivation.md`) — the ADR is *about* the csi_sections table at the time of writing; the filename reflects that historical context. Inside the ADR body, the table name will be updated to `spec_sections` with a brief migration note.

---

## File Structure

**Migration (new):**
- Create: `src/db/migrations/009_rename_csi_sections_to_spec_sections.ts`

**SQL refs (modify):**
- Modify: `src/db/seed.ts` — `INSERT INTO csi_sections ...`
- Modify: `src/db/queries/search.ts` — LEFT JOIN + SELECT
- Modify: `src/lib/infer-section.integration.test.ts` — test description string
- Modify: `src/mcp/server.integration.test.ts` — test comment + SELECT query

**Docs (modify):**
- Modify: `docs/adr/007-all-divisions-from-day-one.md` — one reference to `csi_sections`
- Modify: `docs/adr/012-ufgs-as-reference-not-authoritative-csi.md` — three references
- Modify: `docs/adr/013-csi-sections-seed-public-domain-derivation.md` — body updates + migration note
- Modify: `docs/references/UFGS/README.md` — one reference

**Issues (already shipped):** #39, #44, #47, #53 bodies updated via `gh issue edit` before this branch was opened.

---

## Migration Strategy Research

**Option A — `ALTER TABLE ... RENAME TO ...` (CHOSEN):**
- Atomic; data, foreign keys, sequences preserved automatically.
- Indexes and constraints are NOT auto-renamed by Postgres. The index `csi_sections_division_index` keeps its old name (still attached to the renamed table — but cosmetically stale).
- Need a single explicit `ALTER INDEX ... RENAME TO ...` for tidiness.
- Reversible via the symmetric `down` migration.

**Option B — Create new table + copy + drop:**
- Required only if schema is changing simultaneously. We're not changing schema.
- Higher risk (data copy can fail mid-flight); slower.
- Rejected.

**Option C — pg_dump / restore:**
- Sledgehammer; not appropriate for a single-table rename.
- Rejected.

**Choice: Option A.** Migration is ~5 lines.

**Backwards compatibility:** SpecR is pre-release (v0.1.0). No external production DBs exist. The only DBs in use are local developer instances and CI ephemeral postgres. Both apply migrations via `pnpm migrate`. Migration 009 will run automatically the next time `pnpm migrate` is invoked.

---

## Phase 1: Write the migration

### Task 1.1: Migration file

**Files:**
- Create: `src/db/migrations/009_rename_csi_sections_to_spec_sections.ts`

- [ ] **Step 1: Write migration**

```typescript
import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.renameTable('csi_sections', 'spec_sections');
  pgm.sql('ALTER INDEX csi_sections_division_index RENAME TO spec_sections_division_index');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql('ALTER INDEX spec_sections_division_index RENAME TO csi_sections_division_index');
  pgm.renameTable('spec_sections', 'csi_sections');
};
```

- [ ] **Step 2: Verify with type-check**

Run: `pnpm lint`
Expected: zero errors.

---

## Phase 2: Update SQL references in src/

### Task 2.1: src/db/seed.ts

- [ ] **Step 1: Replace `INSERT INTO csi_sections` → `INSERT INTO spec_sections`**

The full SQL string at line 69-71 changes:

```typescript
// Before
`INSERT INTO csi_sections (section_number, title, division)
 VALUES ($1, $2, $3)
 ON CONFLICT (section_number) DO UPDATE SET title = EXCLUDED.title`,

// After
`INSERT INTO spec_sections (section_number, title, division)
 VALUES ($1, $2, $3)
 ON CONFLICT (section_number) DO UPDATE SET title = EXCLUDED.title`,
```

Also update the log line strings if they reference "CSI sections" — leave the descriptive log message ("seeded CSI sections") alone if it's nominative; the user-facing log is fine. Only SQL identifiers change.

### Task 2.2: src/db/queries/search.ts

- [ ] **Step 1: Replace two SQL string references**

Line 55: `FROM csi_sections cs` → `FROM spec_sections cs`
Line 69: `SELECT title FROM csi_sections WHERE section_number = $1 LIMIT 1` → `SELECT title FROM spec_sections WHERE section_number = $1 LIMIT 1`

### Task 2.3: src/lib/infer-section.integration.test.ts

- [ ] **Step 1: Update test description**

Line 26: `'returns null for section not in csi_sections'` → `'returns null for section not in spec_sections'`

### Task 2.4: src/mcp/server.integration.test.ts

- [ ] **Step 1: Update comments + query**

Lines 56-59:
- comment "Use a section that exists in csi_sections" → "spec_sections"
- comment "Query csi_sections to find" → "Query spec_sections to find"
- query `SELECT section_number FROM csi_sections WHERE division = '27' LIMIT 1` → `SELECT section_number FROM spec_sections WHERE division = '27' LIMIT 1`

---

## Phase 3: Run migration + tests locally

- [ ] **Step 1: Ensure postgres is up**

Run: `docker compose up -d postgres`
Expected: container running.

- [ ] **Step 2: Apply migration**

Run: `pnpm migrate`
Expected: log entry showing `009_rename_csi_sections_to_spec_sections` applied.

- [ ] **Step 3: Verify rename in DB**

Run: `docker compose exec postgres psql -U specr -d specr -c '\dt'`
Expected: `spec_sections` present, `csi_sections` absent.

- [ ] **Step 4: Re-seed**

Run: `pnpm seed`
Expected: section rows inserted into `spec_sections` (no errors about missing table).

- [ ] **Step 5: Run unit tests**

Run: `pnpm test`
Expected: 462+ passing.

- [ ] **Step 6: Run integration tests**

Run: `pnpm test:integration`
Expected: all pass (the two test files updated in Tasks 2.3 + 2.4 must reach the renamed table).

- [ ] **Step 7: Test down migration**

Run: `pnpm migrate:down`
Then verify: `docker compose exec postgres psql -U specr -d specr -c '\dt'`
Expected: `csi_sections` back, `spec_sections` gone.

Then re-up: `pnpm migrate`

---

## Phase 4: Update docs

### Task 4.1: ADR-007

- [ ] **Step 1: Replace `csi_sections` references**

`docs/adr/007-all-divisions-from-day-one.md:23` — `csi_sections` → `spec_sections`.

### Task 4.2: ADR-012

- [ ] **Step 1: Replace 3 references**

Lines 7, 23, 25: `csi_sections` → `spec_sections` (preserve surrounding prose).

### Task 4.3: ADR-013

- [ ] **Step 1: Replace body references + add migration note**

Update lines referring to `csi_sections` as the table name → `spec_sections`. Keep the ADR filename as-is (it's a historical reference to the original table name). Append a short section at the end:

```markdown
## Update 2026-05-18: Table renamed to spec_sections

Migration `009_rename_csi_sections_to_spec_sections` renames the table as part of trademark hygiene. The provenance guarantees in this ADR continue to apply unchanged to the renamed table.
```

### Task 4.4: docs/references/UFGS/README.md

- [ ] **Step 1: Replace one reference**

`csi_sections` → `spec_sections`. The cross-link to ADR-013 stays.

---

## Phase 5: Commit + PR

- [ ] **Step 1: Stage migration + SQL updates as one commit**

```bash
git add src/db/migrations/009_rename_csi_sections_to_spec_sections.ts \
        src/db/seed.ts src/db/queries/search.ts \
        src/lib/infer-section.integration.test.ts \
        src/mcp/server.integration.test.ts
git commit -m "feat(db): rename csi_sections table to spec_sections (migration 009)"
```

- [ ] **Step 2: Stage doc updates as a second commit**

```bash
git add docs/
git commit -m "docs: align csi_sections references with renamed table"
```

- [ ] **Step 3: Stage spec file**

```bash
git add docs/superpowers/specs/2026-05-18-csi-sections-rename-and-issue-sync.md
git commit -m "docs(spec): record rename + issue-sweep plan for archival"
```

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin chore/db-rename-csi-sections
gh pr create --title "chore(db): rename csi_sections → spec_sections + open-issue sweep" --body-file ...
```

PR body should note:
- This is the deferred Phase C3 from PR #78
- Migration 009 is reversible
- Issues #39, #44, #47, #53 already updated separately via `gh issue edit` (no code changes for those)
- Test plan: `pnpm migrate && pnpm seed && pnpm test && pnpm test:integration`

---

## Verification Plan

- [ ] `pnpm lint` — zero errors
- [ ] `pnpm test` — 462+ pass
- [ ] `pnpm test:integration` — all pass
- [ ] `pnpm migrate:down && pnpm migrate` — round-trip works
- [ ] `git grep -n 'csi_sections' src/` — zero matches outside the new migration's down direction (which retains the old name as a target for reversibility)
- [ ] `git grep -n 'csi_sections' docs/adr/ docs/references/` — zero matches outside ADR-013's historical filename and the migration-note section
