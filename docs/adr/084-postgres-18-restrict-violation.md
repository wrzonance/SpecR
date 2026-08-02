# ADR-084: Move to Postgres 18, and accept both RESTRICT SQLSTATEs

## Status

Accepted

## Context

The repo ran `postgres:16` everywhere (`docker-compose.yml`, `ci.yml`,
`release.yml`, and the setup note in `AGENTS.md`). Renovate proposed the move to
18 as PR #594; that PR was closed and the bump was deliberately deferred in
issue #599, with the deferral encoded in `renovate.json` as a
`docker`/`postgres` rule bounded to `<17` so it would stop being re-proposed.

The deferral rested on a diagnosis that turned out to be **wrong**. Issue #599
recorded that under Postgres 18 the SQLSTATE "does not reach the pg driver" —
that `getPgCode` returned `undefined` — and concluded the blocker was a
driver-side parsing gap in `node-postgres`, to be retried after bumping `pg`.
Two integration tests failed on 18.4 against a clean pass on 16:

- `src/db/queries/numbering-profiles.integration.test.ts` › `(c) throws NumberingProfileInUseError when a spec references the profile`
- `src/api/numbering-profiles.integration.test.ts` › `DELETE /numbering-profiles/:id` › `409 — profile in use by a spec`

Reproducing directly in `psql`, with no application code in the path, shows what
actually changed. Same schema, same `DELETE`, one `ON DELETE RESTRICT` foreign
key:

```text
postgres:16.13 → ERROR:  23503: update or delete on table "parent" violates
                 foreign key constraint "child_pid_fkey" on table "child"

postgres:18.4  → ERROR:  23001: update or delete on table "parent" violates
                 RESTRICT setting of foreign key constraint "child_pid_fkey"
                 on table "child"
```

Postgres 18 disambiguates a case the SQL standard has always distinguished. A
delete blocked by a dependent row is now `23001` (`restrict_violation`), and
`23503` (`foreign_key_violation`) is reserved for the other direction — a row
referencing a row that does not exist. SQLSTATE was never missing; it changed
value, `pgErrorToHttp`'s switch did not recognise the new one, and the
`code: undefined` in the issue was the *mapped* result rather than the raw code.
No `pg` bump was required, and none was made.

The change is scoped to RESTRICT. A foreign key with no `ON DELETE` clause
(default `NO ACTION`) still raises `23503` on both versions — verified the same
way — so only RESTRICT-protected deletes are affected.

## Decision

**Move to `postgres:18`** across all four pinned locations in one commit, and
teach the error layer both codes.

1. `isRestrictedDeleteViolation(err)` in `src/lib/pg-errors.ts` returns true for
   `23503` **or** `23001`. Call sites guarding a delete against a
   RESTRICT-protected parent use the predicate instead of comparing to a literal
   code. Two live sites: `deleteNumberingProfile` and `deleteTemplate`.
2. `pgErrorToHttp` maps `23001` → **409**, keeping `23503` → 404. These are
   genuinely different outcomes: 404 means the referenced row does not exist,
   while 409 means the target exists and cannot be removed yet. Every existing
   override map keys `23503` for the create-with-a-bad-FK direction
   (`'library not found'`, `'project not found'`, `'referenced scope not
   found'`), which is unchanged on 18, so no caller silently loses its message.
3. `renovate.json`'s database pin is re-bounded from `<17` to `<19` rather than
   removed, so patch and minor releases inside 18 keep flowing while a future
   major stays a deliberate decision — the same shape as the Node (`<25`),
   TypeScript (`<6.0.0`) and ESLint (`<10.0.0`) bounds.

Accepting both codes rather than switching to `23001` outright is deliberate.
The predicate keeps working if a developer or a reviewer runs 16 locally, and
the cost is one extra comparison.

## Consequences

- **Classification** of a RESTRICT-blocked delete is identical on 16 and 18 —
  `isRestrictedDeleteViolation` returns true on both — so the move is not a
  one-way door and the predicate still works for anyone running 16 locally.
  The resulting **HTTP status is not** identical, and cannot be:

  | Server | SQLSTATE | `pgErrorToHttp` |
  | --- | --- | --- |
  | ≤ 16 | `23503` | 404 — that code must keep its references-a-missing-row meaning, which is what every override map in the API uses it for |
  | 18 | `23001` | 409 — its own code, and the more accurate answer for a blocked delete |

  Only 18 is a supported target after this change, so 409 is the behaviour that
  ships. The 404 on 16 is recorded because a developer running 16 locally will
  observe it, and because the asymmetry is what makes a naive
  "assert 409 everywhere" test pass on 18 and fail on 16 —
  `src/lib/pg-errors.integration.test.ts` therefore asserts that a mapping
  *exists* and leaves the exact `23001` → 409 pair to the unit test.
- `pgErrorToHttp` gains a mapping no route exercises **today** — the other three
  `ON DELETE RESTRICT` foreign keys (`projects.client_id`, the package-revision
  parent, and the spec style source) have no DELETE endpoint for the parent row.
  It is added anyway because without it the next such endpoint would return a
  silent 500 under 18, which is precisely the failure this ADR documents.
- **`docker-compose.yml`'s volume mount moves** from
  `specr_pgdata:/var/lib/postgresql/data` to `specr_pgdata:/var/lib/postgresql`.
  Postgres 18 images store data in a major-version subdirectory of
  `/var/lib/postgresql` to support in-place major upgrades; mounting the old
  path makes the image treat the volume as a stale pre-18 data directory and
  refuse to start (docker-library/postgres#1259). **An existing local
  `specr_pgdata` volume is effectively orphaned** — developers get an empty
  database and must re-run `pnpm migrate && pnpm seed`. There is no in-place
  upgrade path here; the volume holds only local development data.
- Postgres 16 was supported until 2028-11-09, so this buys runway rather than
  answering a deadline. Postgres 18 is supported to 2030-11-14.
- The `23503`/`23001` split is a real portability trap for any future code that
  compares SQLSTATE literals around a delete. The predicate is the intended
  entry point; comparing to `'23503'` directly is the anti-pattern.
