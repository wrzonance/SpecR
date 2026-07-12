# ADR-066: Revision relationships — parent (custody) vs base (comparison lineage)

## Status

Accepted

## Context

Construction reality nests post-issuance change directives **under** the issuance
they modify — CCD-001/002 under *Issued for Construction*, CCD-003/004/005 under
*Bulletin 1* — and separately, an addendum is **diffed against** an earlier
issuance to render only what changed. Today `package_revisions` (migrations
021/028) is strictly flat: `ccd` and `addendum` are just nomenclature type keys
(ADR-025 D2), with no link to the issuance a CCD belongs under, and no persisted
record of which revision an addendum was compared against — `baseRevisionId`
exists only as a request parameter of `POST /revisions/{id}/generate` (addendum
mode, ADR-017 D3), chosen at render time and never stored.

These read as the same idea ("this revision relates to that one") but are two
distinct edges:

- **Grouping/custody** — *Addendum 1* sits top-level in the issuance sequence
  (no parent) but CCD-002 hangs **under** it. This is presentation/custody
  structure: "which issued set does this belong to?"
- **Comparison lineage** — *Addendum 1* was **diffed against** *100% CD / Bid
  Documents* to compute its changed-sections render. This is a rendering input,
  independent of where the addendum sits in the custody tree.

A CCD nested under an issuance is not necessarily comparing itself against that
issuance, and an addendum's comparison base is not necessarily its custody
parent — so one column cannot serve both purposes without silently conflating
them. ADR-025 D2's one-table argument establishes that same-shape revision
types share one `package_revisions` table; it does not decide whether that
table may express relationships between its own rows, which is the gap this
ADR closes. ADR-015 D6 mapped custody as a straight chain (master → project
copy → snapshot) with no branching inside a single revision; nesting extends
that chain, it does not replace it.

Issue #389 (this PR) adds the custody edge. Issue #390 (follow-up, same
module) persists the comparison edge. One ADR decides both so the two columns
read as one coherent design rather than two ad hoc additions.

## Decision

Add **two** nullable self-referencing foreign keys on `package_revisions`,
each a distinct semantic edge on the same spine table (ADR-025 D2's
single-table shape, extended — not replaced — by self-reference):

- **`parent_revision_id`** (this PR, migration 046) — the revision this one
  was issued **under**. Git-tag-like custody lineage (ADR-015 D6: "a CCD is a
  tag pointing at another tag's lineage, not a branch" — nesting is a
  parent/child *pointer*, not a `git branch`).
- **`base_revision_id`** (#390, follow-up) — the revision this one was
  **compared against** to compute a changed-sections render. Persists what
  `POST /revisions/{id}/generate`'s `baseRevisionId` parameter already
  computes ad hoc today (ADR-017 D3), so the comparison a manual was actually
  generated from survives past the request that rendered it.

Both are `uuid NULL REFERENCES package_revisions(id) ON DELETE RESTRICT`,
validated the same way, but are independent — a revision may have a parent
without a base (a plain CCD not itself diffed), a base without a parent (a
top-level addendum diffed against the prior issuance), both, or neither.
Conflating them into one column would force every custody-nested revision to
also be a comparison target and vice versa, which is not how either concept
behaves in practice.

### Design decisions

1. **Two columns, not one, and not two tables.** A single `related_revision_id`
   would need a `relationship_type` discriminator and forces mutual exclusion
   or awkward multi-row modeling for the both-parent-and-base case. A separate
   edge table is unwarranted structure for two nullable 1:1 pointers with no
   edge-local attributes — ADR-025 D1's DDL-at-runtime rejection reasoning
   applies by extension: don't build general-purpose graph structure for two
   known, fixed relationships. Two plain columns on the existing spine keep
   both queryable with a simple `WHERE`, keep each independently nullable, and
   keep the invariant checks (same-package, depth) column-scoped and simple.

2. **`RevisionParentValidationError` is its own class, not a reuse of
   `RevisionComparisonError`.** Both enforce "must be same package," but they
   guard different columns with different depth semantics (parent: depth ≤ 1;
   base: no nesting concept — a base is never itself required to be a root).
   Renaming/relocating `RevisionComparisonError` to serve both would blur two
   independently-evolving invariants behind one name; #390 is expected to keep
   `RevisionComparisonError` for the base-column check and introduce no new
   sharing beyond the copy-paste-and-adapt already visible between
   `checkParentRevisionRules` and the existing `validateComparisonPackage`-style
   check in `revisions.ts`. Two small, obviously-named classes cost less to
   read than one overloaded one — matching the DRY-without-over-abstraction
   bar (extract only when the same decision repeats 3+ times).

3. **Depth ≤ 1 is enforced at the query layer, not a DB CHECK.** Same
   reasoning as same-package validation: Postgres CHECK constraints cannot
   express "my parent's parent must be NULL" without a subquery CHECK
   (unsupported) or a trigger, and ADR-025's thin-spine discipline already
   keeps structural rules in the query layer where they can carry a typed,
   contextual error rather than a bare constraint-violation message. `depth
   ≤ 1` is also a v1 product decision (a CCD hangs directly under an
   issuance; nothing hangs under a CCD), not a physical impossibility — so
   it belongs in code that can change without a migration.

4. **`ON DELETE RESTRICT`, deliberately not `SET NULL`/`CASCADE`, on both
   columns.** A revision is an immutable issuance snapshot (ADR-015 D5); no
   delete surface exists for `package_revisions` today. RESTRICT is a
   tripwire against one being added carelessly later — a future delete
   endpoint would fail loudly against any revision still referenced as a
   parent or base, forcing an explicit decision (reparent first? block
   entirely?) instead of silently orphaning or cascading through custody
   history.

5. **No self-reference CHECK (`id <> parent_revision_id` /
   `id <> base_revision_id`).** Structurally unreachable rather than merely
   inconvenient: `id` defaults to `gen_random_uuid()` and is never
   client-supplied, so no caller can know a revision's own id before it
   exists, and the query layer validates the referenced row BEFORE the INSERT
   that creates the child — the child can never appear as its own candidate.
   A CHECK would guard a state the call path cannot produce.

6. **`sort_order` stays flat and total** (non-goal, both issues). Nesting and
   comparison lineage are presentation/custody/rendering concerns layered on
   top of the existing per-package ordering clock, not a replacement for it —
   a CCD nested under an issuance still gets its own `sort_order` in document
   order, independent of its `parent_revision_id`.

7. **Legacy create body stays relationship-less.** `LegacyCreateRevisionBodySchema`
   (`{ label: string }`) is `.strict()`, so it already 422s an unexpected
   `parentRevisionId`/`baseRevisionId` field with no code change — a caller
   using the old shape gets a clear rejection rather than a silently ignored
   field, and the structured body is the only path either relationship can be
   declared through.

## Consequences

- `package_revisions` now expresses two independent relationships to itself;
  future custody/comparison queries ("what was issued under this?", "what was
  this addendum diffed against?") are simple indexed lookups instead of
  unanswerable from the data, closing the gap #389's issue text identified.
- ADR-025 D2's flatness implication is amended: same-shape revision types
  remain one table, but that table is no longer flat — rows may nest via
  `parent_revision_id` and cross-reference via `base_revision_id`. D1–D3's
  core argument (identical-shape types don't need separate tables/DDL) is
  unaffected.
- ADR-015 D6's custody chain gains a branch point: a CCD's chain now reads
  `… → package_revision_specs snapshot → parent_revision_id → issuance`,
  answerable via the same `GET /specs/:id/lineage`-style traversal pattern.
- ADR-017 D3 ("addenda are revision diffs") is unchanged in mechanism —
  `POST /revisions/{id}/generate` still computes the diff at render time —
  but #390 makes the comparison **reproducible without out-of-band
  coordination**: the base used to issue an addendum survives the request
  that rendered it, and an explicit request-time `baseRevisionId` continues to
  override the stored one (existing behavior unchanged, no breaking change).
  ADR-017 D3's `baseRevisionId` request parameter and this ADR's persisted
  `base_revision_id` column are two different lifecycle stages of the same
  concept — the parameter picks it at generate time (still supported), the
  column records it at issue time — not two competing designs.
- Both columns are additive and nullable: existing revisions read with
  `parentRevisionId`/`baseRevisionId` as `null` (always-present-but-nullable,
  mirroring the existing `number` field), and existing clients ignoring the
  new response field see no behavior change.
- `RevisionParentValidationError` (this PR) and `RevisionComparisonError`
  (existing, extended by #390) both map to 422 at the API boundary and
  `{ isError: true }` at the MCP boundary, joining `SnapshotValidationError`
  and `RevisionNomenclatureValidationError` in the same error-class family —
  callers distinguish rejection *reason* from the message, not the HTTP
  status, which stays uniform.
