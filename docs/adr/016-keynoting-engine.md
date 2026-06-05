# ADR-016: Keynoting Engine

## Status: Proposed (not yet scheduled — master grain depends on Phase 2d libraries)

## Context

Keynotes connect drawing annotations to specification content: a drawing callout carries a
keynote code; the keynote resolves to a CSI section (and optionally a specific paragraph).
Revit consumes keynotes as a flat tab-delimited text table (code, description, parent
code) configured per project, and elements carry a keynote type parameter.

Firms maintain a master keynote list. On any given project, only keynotes whose target
section is actually in the project manual are valid — annotating a drawing with a keynote
that points at a section the manual does not contain is a coordination error with
errors-and-omissions exposure.

SpecR has no keynote concept: zero code, zero schema, zero issues. The raw materials all
exist: project TOC membership (`project_specs`), section identity, paragraph identity, and
(Phase 4) Revit parameter mappings.

## Decision

### D1 — Master keynotes live with libraries (ADR-015)

```sql
CREATE TABLE keynotes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id           UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  code                 TEXT NOT NULL,        -- e.g. '09 51 00.A1' — firm convention, opaque to SpecR
  parent_code          TEXT,                 -- keynote table hierarchy
  description          TEXT NOT NULL,
  target_section       VARCHAR(20) NOT NULL, -- CSI section the keynote points at
  target_paragraph_id  UUID REFERENCES paragraphs(id) ON DELETE SET NULL, -- optional deep link
  UNIQUE (library_id, code)
);
```

### D2 — The project keynote set is a filter, not a copy

Valid keynotes for a project = keynotes from the project's source libraries
(`project_sources` order) whose `target_section` is present in the project TOC. Computed
by query; nothing to keep in sync. Per-project keynote overrides are out of scope until a
real need appears.

### D3 — Export in the Revit keynote table format

`GET /projects/:id/keynotes` returns the tab-delimited keynote table filtered per D2; an
MCP tool (`get_project_keynotes`) returns the same data structured. Deterministic output —
directly testable as a pure rendering of query results.

### D4 — Element assignment sync rides Phase 4

The Revit add-in (#48) assigns keynote values to elements; assignments persist via the
existing `revit_parameter_mappings` pattern, so element↔keynote↔spec joins fall out of the
link-inventory read model rather than a new subsystem.

## Consequences

- Keynote validity tracks the TOC automatically: removing a section from a project
  invalidates its keynotes on the next export — the same cascade philosophy as broken
  cross-references. "Keynotes whose target section left the manual" becomes a line item in
  the project coordination report (#84 extension).
- Depends on ADR-015 2d-i (libraries) for the master grain. The export endpoint depends
  only on the existing TOC model and could ship early against a single default library if
  sequenced that way.
- The code format is firm convention, stored opaque. SpecR validates only uniqueness and
  target-section existence — it does not impose a numbering scheme.
- Out of scope: keynote legends on drawings (a BIM-side artifact), per-project keynote
  text overrides, and importing external keynote table files (a future loader).

## Related

- ADR-015 (library grain), ADR-009 (Revit add-in calls the REST API), #84 extension
  (coordination report), #48 (add-in scaffold)
