# ADR-025: Revision nomenclature — structure-as-data, not runtime DDL

## Status: Accepted

Builds on ADR-021 (extensible JSONB storage), ADR-015 D5 (immutable revision snapshots),
ADR-017 (issuance & addenda). Companion issue: #209 (revision-nomenclature foundation).
Same extensibility primitive as ADR-022's convention profiles (#137).

## Context

Revision nomenclature — *addendum / bulletin / ASI / proposal request / CCD / milestone
issuance (SD · DD · CD · IFB · IFC)*, and each one's **naming and numbering format** — is
**project- and client-specific user data, not a universal taxonomy**. The same instrument
is named and numbered differently from firm to firm and client to client. Today
`package_revisions` stores only a freeform `label` (`'Addendum 2'`, `'100% CD'`), which is
too loose: there is no structured type, number, title, or date to render, sort, or query.

Users (eventually via a web dashboard, immediately via the API) must be able to **define
their own revision types with sensible defaults and edit them**. The open question was how
to make a revision type *structured* (a real "short name + number + description + date"
contract) rather than a text blob, while keeping it **user-definable at runtime**.

A natural-seeming idea was considered and **rejected**: have the API run **DDL at runtime**
— when a user creates a type "addendum", `CREATE TABLE addendum (...)` with a foreign key
to a universal `revisions` table, so each type is a real table with real typed columns.

## Decision

### D1 — Reject runtime, user-driven DDL

The backend MUST NOT execute `CREATE TABLE` / `ALTER TABLE` in response to user input.
Schema evolution stays where it is: `node-pg-migrate` migrations at deploy time,
version-controlled and reversible (the migration files remain the schema of record).
Reasons:

- **It breaks the typed contract the system rests on.** TypeScript types, Zod boundary
  validation, `openapi.yaml`, and the module boundaries all target a *known, fixed* schema.
  A table named from user data that did not exist at build time cannot be typed, validated,
  documented, or safely queried.
- **User input as a SQL identifier is unsafe and ill-defined.** Identifiers cannot be
  parameterized (`$1` binds values, not table names), forcing string-built DDL — an
  injection surface — and every naming problem follows (reserved words, case-folding,
  length limits, cross-tenant collisions).
- **Environments diverge.** Dev, staging, prod, and each test run would hold *different
  schemas* depending on their data, breaking reproducibility, seeding, backups, and schema
  diffing. The linear migration history would stop describing reality.
- **Operational cost.** `CREATE`/`ALTER` take heavy locks unsuited to request-path execution.

### D2 — Identical-shape types are one table with a `type` column

If `addendum`, `bulletin`, and `ccd` all carry the same fields (short name, number,
description, date), they are **one structure**, not three. N physical tables differing only
by name is a denormalized restatement of a single table differentiated by a `type` value.
A single `revisions` spine table models them directly — and keeps "all addenda in this
package" a trivial `WHERE type = 'addendum'` query.

### D3 — Structure-as-data: a per-type field schema validated at the boundary

Where types genuinely differ in shape, the structure lives in **data, not DDL**. A revision
**type definition** (a row in the #209 nomenclature profile — the same scoped-profile shape
as `editing_conventions`, ADR-022) carries a **field schema**:

```jsonc
{ "type": "addendum",
  "naming": "Addendum {number}",
  "fields": [
    { "key": "shortName",   "kind": "string", "required": true },
    { "key": "number",      "kind": "int",    "required": true, "sequence": "per-package" },
    { "key": "description", "kind": "string" },
    { "key": "date",        "kind": "date",   "required": true } ] }
```

A revision row keeps a thin **invariant spine** as real columns (`package_id` FK, `date`,
an ordering key, a `type` string reference, the existing snapshot relation) and stores its
type-specific values in an **open JSONB `attributes`** bag. The API **validates `attributes`
against the referenced type's `fields` schema** at the write boundary — the same open-Zod
discipline already used for `source_facts` and `editing_conventions.rules` (ADR-021:
capture faithfully, validate, never silent-drop). Built-in default types ship seeded.

This yields exactly the goal: a revision type is **structured** (its fields are an enforced,
named, typed contract) *and* **user-definable at runtime** (defining a type is an API call
that writes a row, never DDL).

## Consequences

- **Structure without schema churn.** "An addendum has short name + number + description +
  date" is enforced and queryable, with zero runtime DDL, zero environment divergence, and
  full build-time type safety.
- **Validation moves into the app boundary**, not the database. We trade DB-level column
  constraints for Zod validation against the per-type field schema. Consistent with how the
  rest of SpecR already validates JSONB payloads.
- **JSONB query/index caveats.** Filtering or ordering on a field inside `attributes` uses
  JSONB operators (and, if hot, an expression index) rather than a plain column. The
  invariant spine (`date`, ordering key, `type`) stays as columns precisely so the common
  sorts/filters never touch JSONB.
- **Sequence handling is app-level.** Per-type sequential numbering (`Addendum {number}`)
  is allocated and uniqueness-checked in the query layer, since the number lives in
  `attributes`; #209 owns that mechanism.
- **Forward-compatible.** New types, new fields, and (later) firm/client scope tiers are
  data and migrations — never user-triggered DDL. If a type ever needs first-class
  relational columns, that is a deliberate, reviewed migration, not a runtime side effect.
- This is the platform's recurring **scoped user-definable profile + open JSONB + defaults**
  pattern (conventions #137, headers/footers #208, style #125); revision nomenclature (#209)
  adopts it rather than inventing a bespoke mechanism.
