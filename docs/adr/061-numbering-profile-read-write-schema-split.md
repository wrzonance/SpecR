# ADR-061: Split read vs. write validation for stored numbering profiles

**Status:** Accepted

## Context

A `NumberingProfile` (`src/ast/numbering-profile-schema.ts`) is persisted as JSONB in
`numbering_profiles.rules` (migration 038) and re-validated with
`NumberingProfileSchema.parse()` on **every read** — `rowToProfile` and the
`getEffectiveNumberingProfile` fallback both route through it
(`src/db/queries/numbering-profiles.ts`).

That single schema served two different jobs: validating client input at write ingress
(create/update, API request bodies) **and** re-parsing our own stored rows on read. The
two jobs have opposing failure modes. A write validator should be strict — reject bad
input at the boundary. A read validator sees data we already accepted under whatever
contract was current when it was written, so it should be tolerant of shapes that were
valid then but are not now.

Because reads used the strict schema, any **tightening** of `NumberingProfileSchema`
retroactively turned a previously-valid stored row into a parse throw — a **500 on read**
rather than a clean return. The concrete trigger (PR #322, #320) tightened `articleIlvl`
from `min(0)` to `min(1)`: a profile persisted under the old contract with
`articleIlvl: 0` would now 500 on `GET`, on list, and on effective-profile resolution
(which feeds document generation). There is no at-risk data today (the only guaranteed
row is the built-in `CSI Default` seed, which has no `articleIlvl`; CI rebuilds the DB
fresh), so this is a latent-risk hardening, not an incident fix — but every future
tightening inherits the same trap.

The issue (#323) offered three options: (1) a read-tolerant path (coerce/quarantine on
failure), (2) a normalizing data migration paired with every tightening, or (3) split
read vs. write schemas. It recommended (3) or (1).

## Decision

Adopt option **(3): split the read and write schemas.**

- `NumberingProfileSchema` — the **strict WRITE** contract, unchanged. Keeps the CSI
  integer-PART model and all policy bounds (`part.maxCount` in `[1,5]`, `articleIlvl`
  `min(1)`, `ilvl` `min(0)`). Used at every write ingress: `createNumberingProfile`,
  `updateNumberingProfile`, and the API request-body schemas in `src/ast/schemas.ts`.
  Invalid client input is still rejected 422 at the boundary.
- `NumberingProfileReadSchema` — a **lenient READ** contract, new. Same *shape* as the
  write schema (field presence, JS types, the closed `tier` vocabulary, the
  `numberStyle: 'integer'` literal, `.catchall(JsonValue)` passthrough) with the numeric
  **policy bounds relaxed to their structural floor** (`min`/`max`/`positive` dropped).
  Used only on the read paths: `rowToProfile` and the `getEffectiveNumberingProfile`
  fallback.

Read and write schemas differ only in refinements (`min`/`max`/`positive`), which do not
affect `z.infer`, so both yield the identical runtime type. `NumberingProfile` remains
the canonical type, inferred from the write schema; a read parse produces an assignable
value. This keeps the split zero-churn for every downstream consumer of the type.

The read schema is deliberately **not** a rubber stamp: a structurally-broken row
(missing the required `part` tier, an unknown `tier` name, a wrong JS type) still throws,
so genuine corruption surfaces as an error rather than propagating silently.

Options (1) and (2) were rejected. (1)'s coerce-to-nearest-valid silently rewrites the
meaning of stored data on read; its quarantine-as-4xx variant makes a legacy profile
*unreadable*, which would break document generation for any spec assigned it — worse than
the 500 it replaces. (2) couples correctness to remembering to author and run a data
migration on every schema change, and cannot retroactively protect a row already
persisted under a contract that has since moved; the read/write split protects all
historical rows structurally, with no per-change migration.

## Consequences

- Reads of a numbering-profile row that no longer satisfies the current strict write
  schema return the row instead of 500ing. Writes stay strict — bad input is still
  rejected 422 at ingress.
- This establishes a **table-wide convention** for `numbering_profiles`: reads validate
  with the lenient schema, writes with the strict one. It generalizes to any future
  stored-JSONB contract with the same read/write asymmetry.
- **Maintenance rule.** A future write-side tightening that is a *numeric bound* is
  already covered — the read schema drops all bounds. A tightening of a *different* kind
  (narrowing a literal/enum, adding a required field) must be mirrored as a relaxation in
  `NumberingProfileReadSchema`, or it reintroduces the read-500 risk. The read-tolerance
  tests (`numbering-profile-schema.test.ts`, `numbering-profiles.integration.test.ts`)
  are the guardrail: they assert legacy shapes read back cleanly while writes reject them.
- The two schemas can drift in principle. They are kept adjacent in one file with the
  shared sub-schema shape visible on a single screen, and the tests pin the read
  tolerance, so drift is caught rather than latent.
