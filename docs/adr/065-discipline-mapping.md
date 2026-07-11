# ADR-065: Discipline mapping (division→discipline, scoped-profile)

## Status

Accepted

## Context

Spec sets are organized and staffed by engineering discipline (Electrical, HVAC,
Plumbing, …), but the API had no notion of discipline — so every client that
wanted "show me the electrical sections" or a per-discipline rollup hard-coded its
own division→discipline table (issue #448). That mapping is mostly CSI convention
with firm-specific exceptions, which is exactly the shape the existing
scoped-profile pattern (built-in default + per-library override) already handles
for `editing_conventions` (ADR-022) and `numbering_profiles`.

## Decision

Add a global `disciplines` catalog and a library-scoped `discipline_section_rules`
table (migration 044). A rule maps an **inclusive CSI division range** (2-digit,
`division_start`..`division_end`) to a discipline. Built-in default rows have
`library_id IS NULL`; a library's own rows override.

**Resolution is all-or-nothing per library** (identical to `editing_conventions`):
a library with any rules of its own uses ONLY those; a library with none inherits
the built-in default. A single `scope` parameter drives every read — the library's
id when it has rules, else `null` (built-in). `disciplineForSection` is a pure
function mapping a section's first two digits to a discipline key.

Reads: `GET /disciplines` (resolved catalog for an optional `libraryId`, with
`meta.inherited`), a `discipline` filter + resolved `discipline` field on
`GET /libraries/{id}/specs` and the new `GET /projects/{id}/specs`. Writes:
`PUT /libraries/{id}/disciplines` (replace the rule set wholesale) and
`DELETE /libraries/{id}/disciplines` (clear the override). All mirrored as MCP
tools (`list_disciplines`, `list_project_specs`, `set_library_disciplines`,
`clear_library_disciplines`) with contract-map parity (ADR-044) and tiers (ADR-045).

### Design decisions

1. **Division granularity.** Rules match at the 2-digit CSI division, which IS the
   MasterFormat discipline boundary and the section number's own prefix — so the
   issue's "section prefix or range" is satisfied without lexicographic
   string-range ambiguity. A single division is `start == end`.

2. **CSI-accurate default 21/22/23 split.** The issue delegated this split. The
   built-in default is 21=Fire Suppression, 22=Plumbing, 23=HVAC (plus
   25=Integrated Automation for I&C, 26=Electrical, 27=Communications,
   28=Electronic Safety & Security). A firm that groups all mechanical trades under
   one "Mechanical" discipline overrides with a single range rule `21–23 →
   Mechanical` — the exact per-library override this feature ships, so the
   ambiguity becomes a demonstration of it. "Mechanical" is seeded in the catalog
   (unmapped by default) as that override target.

3. **Disciplines are a global catalog.** Overrides remap divisions to existing
   catalog disciplines; there is no add-discipline endpoint in scope. A brand-new
   firm-specific discipline is a documented future enhancement.

4. **Project listings resolve against the built-in default.** Project spec copies
   have `library_id IS NULL` and a project may draw from several source libraries,
   so there is no single library lens; the built-in default is the deterministic,
   unambiguous choice. Per-library override is exercised on the library listing.

5. **Row `discipline` is the discipline key** (slug, e.g. `electrical`) or `null`
   for an unmapped division. Clients resolve key→display name + rules via
   `GET /disciplines`, keeping listing rows lean.

## Consequences

- Out of the box, both listings filter by discipline using the seeded CSI-division
  default; a library overrides its mapping without affecting others; spec rows
  carry their resolved discipline so clients never re-derive it (the three #448
  acceptance criteria).
- `listLibrarySpecs` moved its filter arguments to an options object
  (`{ includeWithdrawn?, discipline? }`) — the two existing callers were updated.
- `GET /projects/{id}/specs` is a NEW listing endpoint (only POST/DELETE existed),
  completing the project-specs REST resource.
- INV-5: `list_disciplines` is shape-exempt (its REST op carries `meta.inherited`
  the bare tool payload can't reconstruct); `list_project_specs` is read-pending
  (mirrors REST 1:1 but needs a seeded project TOC to drive), alongside
  `list_library_specs`.
- Migration 044 is reversible; the write path validates 2-digit divisions,
  `start <= end`, non-overlapping ranges, and catalog membership (unknown key →
  422, atomic rollback).
