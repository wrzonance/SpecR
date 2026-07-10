# ADR-063: Reference-graph edges resolve scope-relative

## Status

Accepted

## Context

Issue #447 adds a one-call section-reference graph per project/library
(`GET /projects/{id}/reference-graph`, `GET /libraries/{id}/reference-graph`,
MCP `get_reference_graph`). Each edge must carry a "resolved target spec id
(null = dangling)".

The DB already stores `spec_references.target_spec_id`, but that column is
resolved differently depending on who owns the reference:

- **Project copies** — `cloneRefs` (`src/db/queries/derive.ts`) resolves it
  **project-scoped** at clone time (`LEFT JOIN specs tgt ON tgt.project_id = $1
  AND tgt.section = …`), and `insertTocEntry` / removal keep it in sync as
  sections are added/removed. It always points at the project spec with the
  matching section, or NULL + `is_broken`.
- **Library masters** — `insertRefs` (`src/db/queries/refs.ts`) resolves it via a
  **global** `SELECT id FROM specs WHERE section = $1 LIMIT 1`. It can point at a
  spec in any library, or even a project copy. It is not library-relative.

A graph must only connect nodes that are actually in the graph. Trusting the
stored column for a library scope would produce edges pointing outside the node
set.

## Decision

Resolve every edge's `targetSpecId` **in code** by matching its target section
against the in-scope node set (a `section -> specId` index built from the graph's
own nodes). Applied uniformly to both scopes. Dangling means "target section
absent from this scope"; the graph does not read the stored `is_broken` flag.

## Consequences

- For projects, scope-relative resolution **coincides** with the stored
  `target_spec_id` (both are project-scoped), so the graph agrees with the
  per-spec `getOutboundReferences` endpoint — pinned by a regression test in
  `src/db/queries/reference-graph.integration.test.ts` (the #447 acceptance
  criterion "graph contents agree with the per-spec reference endpoints").
- For libraries, edges correctly resolve within the library instead of leaking to
  global matches.
- Umbrella annotations reuse `buildUmbrellaCalloutFindings` (ADR-042) unchanged,
  fed directly from the graph's nodes and section-reference rows.
- Pure, DB-free assembly lives in `src/db/queries/reference-graph.ts` (unit
  tested); the read layer in `src/db/queries/reference-graph-read.ts`. No
  migration — this is a read model over existing tables.
