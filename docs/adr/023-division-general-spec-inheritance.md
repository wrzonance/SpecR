# ADR-023: Division-General Spec Inheritance

## Status

Accepted

## Context

SpecR already has two inheritance-like relationships:

- `paragraphs.parent_id` models the CSI SectionFormat paragraph tree inside one spec.
- `specs.parent_spec_id` models chain-of-custody derivation: reference/company/client/project copies.

Firms also need division-level context: a Division 27 package may include `27 00 00`
general requirements, and other Division 27 sections should be able to identify that
section as their division root. This is not copy provenance. A section can derive from a
company master while also using a same-project `27 00 00` as package context.

Some packages intentionally omit `NN 00 00` because another team issues that section. In
that case, automatically choosing the lowest-numbered section would create false
inheritance.

## Decision

Add a separate `division_general_specs` table, scoped to either a library or project.

Only exact `NN 00 00` matches are assigned automatically. If exact is absent, the API
returns `status: missing` and advisory candidates, but no fallback is persisted as the
division general spec.

Manual decisions are explicit:

- Assign a same-scope spec in the requested division as `general_spec_id`.
- Mark the division `not_applicable` when the general requirements section is issued
  outside this corpus/package.

Automatic reconciliation does not overwrite manual decisions.

## Consequences

- `parent_spec_id` remains pure custody/provenance and is not overloaded with division
  context.
- Missing `NN 00 00` is visible to API clients instead of silently hidden by fallback
  inference.
- Candidate ranking is useful for humans but has no behavioral effect until selected.
- Manual `not_applicable` protects real package boundaries where another firm or team owns
  the division general requirements spec.
