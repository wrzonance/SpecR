# ADR-049: Revit Link Inventory — element↔spec read model

## Status

Accepted (Phase 4 — Revit link inventory, #103). Implements the L-i read model from the
2026-06-05 backlog expansion. Consumes the `revit_parameter_mappings` schema (#46, ADR-009)
without mutating it — the write path is #47.

## Context

`revit_parameter_mappings` (#46) stores element↔paragraph links, but nothing surfaces them as an
inventory: which model elements link to which specs, and what is unlinked on either side. This read
model is the API backbone for the Phase 5 link browser UI (L-ii, #38-gated) and a future coordination
finding class.

The schema's grain is a mapping row keyed on `(paragraph_id, revit_instance_id, revit_component_role,
revit_param)`. A spec is reached only transitively: `mapping → paragraph → spec`. There is **no
`project_id` on mappings** and **no independent registry of Revit model elements** — the mappings
table is the only Revit knowledge in the system. ADR-029 already recorded this exact limitation when
it *deferred* the "unmapped Revit elements" coordination finding: "no model-element registry exists —
`revit.ts` holds parameter *mappings* only."

That creates a direct tension with #103's second acceptance criterion, which asks for both an
**unmapped-element** count and a **spec-without-model-backing** count. This ADR records how the read
model honors that criterion without contradicting ADR-029.

## Decision

Add a **read-only, computed-on-demand** endpoint `GET /projects/:id/revit-links` (+ MCP tool
`list_revit_links`, `read` tier) returning a project-scoped inventory. **No new table, no migration** —
the inventory is derived and cheap, matching the coordination report's stance (ADR-029).

### Scope and shape

The inventory is scoped to mappings whose target paragraph belongs to a **present** project spec
(`project_specs ⋈ specs`, `withdrawn_at IS NULL` — the same present-set guard as the coordination
report). Two pivots and a summary are returned:

- **`byElement`** — one entry per Revit element (`revit_instance_id`), listing the distinct specs it
  drives (element→sections). Naturally expresses the schema's cross-spec fan-out: one family instance
  touches paragraphs across Div 26/27.
- **`bySpec`** — one entry per **present project spec** (specs with zero links included), listing the
  distinct elements linked to its paragraphs (section→elements).
- **`summary`** — `elementCount`, `specCount`, `mappedSpecCount`, `specsWithoutModelBacking`,
  `unmappedElements`, `mappingCount`. The summary is always computed over the **full project scope**,
  never the filtered pivots, so the counts are stable regardless of narrowing.

Optional `?revitInstanceId=` / `?specId=` query params narrow the two pivots (applied in memory over
the project snapshot — a listing convenience, not a scale optimization; at project scale the full read
is negligible, matching the coordination report's compose-in-TypeScript approach).

### The two "unlinked" counts

- **`specsWithoutModelBacking` = present project specs with zero linked elements.** Fully computable
  and demonstrated in the fixture. This is the count that "feeds X-84" (the coordination report).
- **`unmappedElements` = 0 under the current substrate — by construction, not by accident.** Every
  element that reaches a project spec reaches a *present* one (project copies are never withdrawn,
  ADR-030), so the mappings table cannot observe a Revit element that was placed in the model but never
  mapped. Counting those genuinely requires the deferred **model-element registry** (the #82–#85 Revit
  family; ADR-029). The field is kept in the contract at a stable value so the eventual registry adds
  meaning with **no breaking change** for consumers (X-84). An integration test pins the `0` with a
  comment so that a future registry making it non-zero trips the test and forces this decision to be
  revisited — never a silent behavior change (CLAUDE.md OOXML-ambiguity rule, generalized).

### Delivery & error mapping

- Malformed `:id` or `?specId` → **400** (matching the sibling `coordination-report` /
  `required-sections` handlers — `z.uuid()` on an identifier is a 400). Unknown project → **404**
  (`ProjectNotFoundError`). Else `DatabaseError` → 500. No stack traces leave the process.
- The query runs in a single `REPEATABLE READ, READ ONLY` transaction for a consistent snapshot.
- `openapi.yaml` gains the path + `RevitLinkInventory` / `RevitElementLinks` / `RevitSpecLinks` /
  `RevitLinkedSpec` / `RevitLinkSummary` schemas in the same PR (ADR-026 contract gate). The MCP tool
  is contract-bound via `OP_TO_TOOL` (ADR-044) and tier-declared (ADR-045).

### Why a new query module (`revit-links.ts`) rather than extending `revit.ts`

`revit.ts` is the mapping **CRUD** module (#46). The inventory is a project-scoped **aggregation** read
model — a distinct concern, and folding it in would crowd `revit.ts` toward the 400-line cap. It reuses
the same table and conventions and duplicates no CRUD, so it is not a "parallel" mappings module — the
same separation the coordination report keeps from the substrate queries it composes.

## Consequences

- **X-84 gains `specsWithoutModelBacking` now** and `unmappedElements` as a forward-compatible field;
  the deferred registry slots in later with no contract change.
- **Read-only and stateless** — no migration, no write path, no cache. Cost is recomputation per
  request, negligible at project scale for an advisory view.
- **`unmappedElements` is intentionally 0 today.** A reviewer encountering the always-zero field should
  read it here and in the pinned test, not as dead code — it is a documented substrate boundary.
- **Bounded surface:** one query module + one REST handler + one MCP tool + `openapi.yaml`.

## Alternatives considered

- **Define `unmappedElements` over a cross-project element universe** (all `revit_instance_id` in the
  table minus those linked to this project). Rejected — it counts other projects' elements as this
  project's "unmapped," which is noise, and still is not the registry ADR-029 requires.
- **Derive "unmapped" from `direction = 'spec_only'` or from vanished paragraphs.** Rejected — direction
  values beyond `to_spec` are explicitly *reserved / unimplemented* (#46, #85), and vanish-awareness
  would be inconsistent with the present-spec set the rest of the model uses. Both would encode a guess.
- **Fold the read model into `revit.ts`.** Rejected — see above (cohesion + line cap).
- **Materialize the inventory.** Rejected — derived, cheap, advisory; persisting adds staleness and a
  write path the issue scopes out.

## Related

- ADR-009 (Revit direct API calls — the mapping origin), ADR-029 (coordination report; deferred the
  unmapped-Revit finding for the same no-registry reason), ADR-030 (spec withdraw / present-set guard),
  ADR-026 (OpenAPI contract gate), ADR-044 (MCP contract binding), ADR-045 (MCP capability tiers).
- Issues: #103 (this read model), #46 (schema, closed), #47 (mapping write path), #82–#85 (Revit
  family / model-element registry — upstream of a real `unmappedElements`), #84 (X-84 coordination
  consumer).
