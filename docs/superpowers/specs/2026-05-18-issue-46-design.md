# Issue #46 — Phase 4a: Revit parameter mapping schema + migrations

**Status:** Approved 2026-05-18 — ready for plan + implementation
**Issue:** https://github.com/wrzonance/SpecR/issues/46
**Branch:** `feat/issue-46`
**Assigned migration number:** 012 (after #30 takes 010 + 011)

## Context

ADR-009 specifies that the Revit add-in calls the SpecR REST API directly to populate spec paragraphs from Revit model parameters. Phase 4a establishes the DB foundation for those mappings.

Brainstorming (2026-05-18) surfaced four real-world constraints that significantly reframed the original issue body's schema:

1. **Composite Revit identity.** A single family instance (e.g., "Data Outlet A") contains multiple sub-components (faceplate, jack, conduit, backbox, cable), each with its own parameters. One instance fans out to many mapping rows.
2. **Cross-spec fan-out.** One family instance touches paragraphs across multiple specs (Div 26 pathways + Div 27 telecom). Schema must allow this naturally.
3. **Edge direction.** Some attributes flow Revit→spec (`Manufacturer`); some flow spec→Revit (CAT6A cable performance); some are spec-authoritative and Revit-advisory only. The schema reserves a `direction` enum without implementing all flows.
4. **Project-level preconditions.** Placing a Revit element implies an entire MasterFormat section must exist in the project TOC. This is application logic over existing `project_specs` table, not a new schema concern (see #82).

Downstream PRs (out of scope here):
- **#47** — `PATCH /specs/:id/paragraphs/:nodeId` endpoint that consumes mappings
- **#48** — Revit add-in scaffold (C#/.NET)
- **#49** — Part 2 auto-population logic
- **#50** — Revit change detection / diff preview
- **#82** — Family-category → required MasterFormat sections registry + project preflight
- **#83** — Family-type-level mappings (`revit_family_type_id`)
- **#84** — Multi-Revit-model support (`revit_model_id`)
- **#85** — Bidirectional sync write path

## Schema (migration 012)

`src/db/migrations/012_revit_parameter_mappings.ts` — node-pg-migrate `.ts` migration with `up` and `down`.

```sql
CREATE TABLE revit_parameter_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paragraph_id UUID NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  revit_instance_id TEXT NOT NULL,
  revit_component_role TEXT,
  revit_param TEXT NOT NULL,
  direction VARCHAR(20) NOT NULL DEFAULT 'to_spec'
    CHECK (direction IN ('to_spec','to_revit','bidirectional','spec_only')),
  transform_type VARCHAR(20) NOT NULL
    CHECK (transform_type IN ('replace','placeholder','append','prepend')),
  transform_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (paragraph_id, revit_instance_id, revit_component_role, revit_param)
);

CREATE INDEX revit_mappings_instance_idx
  ON revit_parameter_mappings (revit_instance_id);

CREATE INDEX revit_mappings_paragraph_idx
  ON revit_parameter_mappings (paragraph_id);
```

Down migration: `DROP TABLE revit_parameter_mappings;` (CASCADE handled via FK).

### Column rationale

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID PK | Stable mapping identity for edit/delete |
| `paragraph_id` | UUID NOT NULL FK ON DELETE CASCADE | Target paragraph; spec derived via `paragraphs.spec_id` |
| `revit_instance_id` | TEXT NOT NULL | Revit element GUID, stable per element within a document |
| `revit_component_role` | TEXT (nullable) | Sub-component within composite family (`'faceplate'`, `'jack'`, `'conduit'`, `'backbox'`, `'cable'`, ...). NULL = family-instance-level param |
| `revit_param` | TEXT NOT NULL | Parameter name on that component (`'Manufacturer'`, `'PortCount'`, ...) |
| `direction` | VARCHAR(20) NOT NULL DEFAULT `'to_spec'` + CHECK | Edge direction. Phase 4a implements `to_spec` only; other values reserved |
| `transform_type` | VARCHAR(20) NOT NULL + CHECK | How source value becomes target value |
| `transform_config` | JSONB (nullable) | Per-transform parameters. Shape validated by Zod in app layer (#47), not DB |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | Debug/audit ordering |

### Constraints

- **FK + CASCADE** on `paragraph_id` — deleting a paragraph removes its mappings; cascade through spec deletion via FK chain
- **CHECK** on `direction` — 4 reserved values
- **CHECK** on `transform_type` — 4 supported values
- **UNIQUE NULLS NOT DISTINCT** (Postgres 15+, confirmed PG 16 in `docker-compose.yml`) — natural key treats NULL `revit_component_role` as equal so two identical family-level mappings collide

### Indexes

- `revit_mappings_instance_idx` — fast lookup "what does this Revit element drive?" (cross-spec)
- `revit_mappings_paragraph_idx` — fast lookup "what populates this paragraph?" (editor UI)

### Decisions captured

| | Original issue #46 | Final |
|---|---|---|
| `spec_id` | denormalized column | dropped; derive via `paragraph_id` FK chain |
| Revit-side identity | flat `revit_param TEXT` | `revit_instance_id` + `revit_component_role` + `revit_param` (composite) |
| `direction` | absent | added; reserves bidirectional/spec-only flows |
| `transform_type` | VARCHAR(20) no constraint | + CHECK with 4 allowed values |
| `transform_config` | JSONB | unchanged (Zod in app layer) |
| Natural key | `(spec_id, paragraph_id, revit_param)` | `(paragraph_id, revit_instance_id, revit_component_role, revit_param)` with `NULLS NOT DISTINCT` |
| `created_at` | absent | added |

## Queries (`src/db/queries/revit.ts`)

```typescript
export interface RevitMapping {
  id: string;
  paragraphId: string;
  revitInstanceId: string;
  revitComponentRole: string | null;
  revitParam: string;
  direction: 'to_spec' | 'to_revit' | 'bidirectional' | 'spec_only';
  transformType: 'replace' | 'placeholder' | 'append' | 'prepend';
  transformConfig: unknown | null;
  createdAt: Date;
}

export interface RevitMappingInput {
  paragraphId: string;
  revitInstanceId: string;
  revitComponentRole?: string | null;
  revitParam: string;
  direction?: RevitMapping['direction'];        // defaults to 'to_spec'
  transformType: RevitMapping['transformType'];
  transformConfig?: unknown;
}

export async function getMappingsBySpec(specId: string): Promise<readonly RevitMapping[]>;
export async function getMappingsByInstance(revitInstanceId: string): Promise<readonly RevitMapping[]>;
export async function getMappingsByParagraph(paragraphId: string): Promise<readonly RevitMapping[]>;
export async function upsertMapping(input: RevitMappingInput): Promise<RevitMapping>;
export async function deleteMapping(id: string): Promise<void>;
```

Re-export all five from `src/db/index.ts` (barrel pattern per CLAUDE.md).

**Rationale:**
- `getMappingsBySpec` joins `paragraphs` on `paragraph_id` filtered by `paragraphs.spec_id = $1` — replaces the dropped `spec_id` denormalization
- `getMappingsByInstance` — "what does this Revit element drive across all specs?"
- `getMappingsByParagraph` — inverse lookup for editor UI
- `upsertMapping` — `ON CONFLICT (paragraph_id, revit_instance_id, revit_component_role, revit_param) DO UPDATE SET ...` — idempotent on natural key
- `deleteMapping` — by `id` only; no bulk delete in this PR
- Return types use `readonly` arrays per coding-style.md immutability
- `transformConfig: unknown` — DB stores arbitrary JSONB; Zod validation lives in app layer (#47)

## Tests

### Integration (`src/db/queries/revit.integration.test.ts`)

- Setup: migrate to 012; seed a spec + paragraphs per test
- `upsertMapping` inserts row with all expected fields; defaults `direction='to_spec'`
- Second `upsertMapping` with same natural key UPDATES (no duplicate row)
- `NULLS NOT DISTINCT` verified: two upserts with `revit_component_role=NULL`, same `instance_id`+`param`+`paragraph_id` → second is UPDATE, single row remains
- `getMappingsBySpec(specId)` returns all mappings for paragraphs in that spec (across multiple paragraphs)
- `getMappingsByInstance(instanceId)` returns rows across paragraphs/specs
- `getMappingsByParagraph(paragraphId)` returns rows targeting that paragraph only
- `deleteMapping(id)` removes by ID; subsequent get returns nothing
- FK CASCADE: delete paragraph → mappings gone; delete spec → mappings gone (via paragraph chain)
- CHECK constraint rejects invalid `direction` (e.g. `'sideways'`) via raw SQL
- CHECK constraint rejects invalid `transform_type` (e.g. `'merge'`) via raw SQL
- Migration down: `pnpm migrate:down` removes 012; re-apply succeeds

### Unit

None — `revit.ts` is thin pass-through to pg. If a `rowToRevitMapping` helper is extracted (likely, to handle nullable + JSONB cast), unit test it.

## Doc updates

- `ARCHITECTURE.md`: document `revit_parameter_mappings` schema in the Database Schema section; note composite Revit identity and direction enum
- Reference #82–#85 as the deferred Phase 4 work that builds on this schema

## Acceptance criteria

- [ ] `pnpm migrate` succeeds through 012; `pnpm migrate:down` reverses cleanly
- [ ] All 4 schema constraints (FK, CHECK direction, CHECK transform_type, UNIQUE NULLS NOT DISTINCT) enforced and tested
- [ ] All 5 query functions return per spec
- [ ] `upsertMapping` idempotent on natural key (including NULL `revit_component_role`)
- [ ] `pnpm lint`, `pnpm test`, `pnpm test:integration` pass
- [ ] PR LOC delta under 500 (target ~250)
- [ ] ARCHITECTURE.md updated with `revit_parameter_mappings` entry

## Out of scope (deferred)

| Excluded | Tracked by |
|----------|-----------|
| `PATCH /specs/:id/paragraphs/:nodeId` endpoint | #47 |
| Revit add-in (C#/.NET) scaffold | #48 |
| Part 2 auto-population logic | #49 |
| Revit change detection / diff preview | #50 |
| Direction flows beyond `'to_spec'` | #85 |
| Family-type-level mappings | #83 |
| Multi-Revit-model disambiguation | #84 |
| Family-category required-sections registry + preflight | #82 |
| `meta.revitParam` in `ast/types.ts` | Verify present per ARCHITECTURE.md; no change if so |

## Risk notes

- **Migration number coordination:** #30 takes 010 + 011; #46 takes 012. If #30 ships first, #46's agent must verify its migration number is still 012 (not 011) before authoring. The parallel-issues agent prompt asserts this.
- **PG 15+ requirement:** `UNIQUE NULLS NOT DISTINCT` requires Postgres 15+. Project runs PG 16 per `docker-compose.yml`. CI uses the same.
- **Empty seed:** This PR does NOT seed any mappings. The table is created empty. Mappings are inserted only via app calls in #47/#48.
- **Cross-spec implication unhandled by schema:** "Placing this family requires Section X exist in project" is application logic in #82, not enforced by FK. A mapping can target a paragraph in any spec; project TOC reconciliation happens elsewhere.
