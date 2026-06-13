# ADR-024: Reference Traversal Query Scope

## Status

Accepted

## Context

`spec_references` stores global edges extracted from specs. Existing consumers could see
outbound references through `getSpecTree`, but there was no reverse query for "what
references this section." Querying the edge table without a scope would blend unrelated
projects, which is deterministic only in the narrow SQL sense and not meaningful for a
project-centric API or MCP tool.

Two lookup directions also have different natural keys:

- Outbound traversal starts from one concrete spec, so `source_spec_id` is the stable key.
- Inbound traversal starts from a target section number. The target spec may not be loaded,
  so requiring `target_spec_id` would hide the most useful missing-section cases.

## Decision

Reference traversal is project-scoped. Callers must provide `projectId`, and traversal
queries join through `project_specs` so only citing specs in that project contribute rows.

Outbound REST traversal is keyed by spec UUID and returns an empty list only for an
in-project spec with no references; a spec outside the project is a 404 at the REST
surface. MCP outbound traversal accepts a section number, resolves all in-project specs
with that section, and flattens their outbound reference rows without collapsing
multi-source sections.

Inbound traversal is keyed by normalized section number and matches
`spec_references.target_spec_section`. This returns references even when the target section
has not been ingested and `target_spec_id` is null.

Library-wide traversal and future master/version/package scopes are deliberately separate
capabilities, not defaults.

## Consequences

- Reverse lookup works for both loaded and unloaded target sections.
- Project APIs cannot accidentally blend references from unrelated projects.
- Multi-source sections remain explicit because each outbound row includes `sourceSpecId`.
- Future scope dimensions can be added as extra filters without changing the meaning of the
  current project-scoped contract.
