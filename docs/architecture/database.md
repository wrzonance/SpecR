# Database Schema (Overview)

> ↩ [Architecture index](../../ARCHITECTURE.md)

```sql
-- Library owners for reference, company, and client masters
CREATE TABLE libraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier VARCHAR(20) NOT NULL,          -- 'reference' | 'company' | 'client'
  name TEXT NOT NULL UNIQUE,
  owner TEXT,
  parent_library_id UUID REFERENCES libraries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Specs
CREATE TABLE specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section VARCHAR(20),  -- "27 21 00" | "26 00 13.10" | "01 32 01.00 10" (expanded shape, ADR-020)
  title TEXT,
  source VARCHAR(20),   -- 'ufgs' | 'arcat' | 'cpi' | 'unknown'
  library_id UUID REFERENCES libraries(id), -- master owner; XOR with project_id
  project_id UUID REFERENCES projects(id),  -- project working-copy owner
  parent_spec_id UUID REFERENCES specs(id), -- copy provenance, not division context
  origin_version INTEGER,
  content_version INTEGER NOT NULL DEFAULT 1,
  origin_meta JSONB,
  onboarding_status TEXT NOT NULL DEFAULT 'active', -- 'review' | 'active' (ADR-022; #139)
  withdrawn_at TIMESTAMPTZ,                          -- NULL = active; soft-withdraw a master (ADR-030)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Paragraph tree (adjacency list — recursive CTEs for traversal)
CREATE TABLE paragraphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id UUID REFERENCES specs(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES paragraphs(id),
  node_type VARCHAR(20),
  text TEXT,
  position INTEGER,      -- sibling order
  vanish BOOLEAN DEFAULT false,
  source_facts JSONB NOT NULL DEFAULT '{}', -- parsed comment/color/choice-token facts (#187)
  classification JSONB,                      -- derived editability classification (ADR-022)
  editability_override JSONB,                -- human override, never merged into classification (ADR-022 D2)
  revit_param TEXT,
  origin_paragraph_id UUID REFERENCES paragraphs(id) ON DELETE SET NULL,
  base_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Version snapshots for 3-way merge
CREATE TABLE paragraph_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paragraph_id UUID REFERENCES paragraphs(id),
  version INTEGER,
  text TEXT,
  node_type VARCHAR(20),
  snapshot_at TIMESTAMPTZ DEFAULT now()
);

-- Projects own a TOC (ordered set of spec sections)
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  -- section_number_format CHECK IN ('canonical','dots','compact','spaced-compact') (ADR-032)
  section_number_format TEXT NOT NULL DEFAULT 'canonical',
  deleted_at TIMESTAMPTZ,   -- NULL = active; soft-delete (ADR-031)
  deleted_by TEXT,          -- free-text actor recorded at soft-delete
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- TOC junction: which specs belong to which project, in what order
CREATE TABLE project_specs (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  spec_id    UUID REFERENCES specs(id)    ON DELETE RESTRICT,
  position   INTEGER NOT NULL,            -- TOC display order
  added_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, spec_id)
);

-- Ordered source libraries for project copy-on-derive resolution
CREATE TABLE project_sources (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  library_id UUID REFERENCES libraries(id),
  priority INTEGER NOT NULL,
  PRIMARY KEY (project_id, library_id)
);

-- Division-general context, separate from spec copy provenance (ADR-023)
CREATE TABLE division_general_specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id UUID REFERENCES libraries(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  division VARCHAR(2) NOT NULL,
  general_spec_id UUID REFERENCES specs(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,           -- 'resolved' | 'not_applicable'
  detection_method VARCHAR(30) NOT NULL, -- 'exact_section' | 'manual'
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Style templates: per-firm DOCX rendering rules
-- (Phase 2c-i schema; applied by the generator via templateId — issue #32)
CREATE TABLE style_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,         -- 'UFGS-Default', 'Acme-Firm', ...
  owner TEXT,                        -- NULL for built-in templates
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-NodeType style rules (one row per node_type per template)
CREATE TABLE style_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES style_templates(id) ON DELETE CASCADE,
  node_type VARCHAR(20) NOT NULL,    -- 'part' | 'article' | 'pr1'..'pr7'
  font_family TEXT,
  font_size_half_pt INTEGER,         -- OOXML native unit (20 = 10pt)
  bold BOOLEAN NOT NULL DEFAULT false,
  caps BOOLEAN NOT NULL DEFAULT false,
  indent_twips INTEGER,              -- OOXML native unit (1440 twips = 1in)
  space_before_twips INTEGER,
  space_after_twips INTEGER,
  numbering_format TEXT,             -- 'PART %1 -', '%1.%2', '%3.', ...
  UNIQUE (template_id, node_type)
);

-- Cross-references extracted at parse time
-- target_spec_id resolved lazily (NULL = unresolved or broken)
CREATE TABLE spec_references (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_spec_id      UUID REFERENCES specs(id)      ON DELETE CASCADE,
  source_paragraph_id UUID REFERENCES paragraphs(id) ON DELETE CASCADE,
  target_type         VARCHAR(20) NOT NULL,  -- 'section' | 'paragraph' | 'standard'
  target_spec_section VARCHAR(20),           -- "09 91 00" / "26 00 13.10" — for section refs
  target_spec_id      UUID REFERENCES specs(id)      ON DELETE SET NULL,
  target_paragraph_id UUID REFERENCES paragraphs(id) ON DELETE SET NULL,
  standard_code       TEXT,                  -- "ASTM C150" — for standard refs
  reference_text      TEXT NOT NULL,         -- verbatim text from source paragraph
  is_broken           BOOLEAN DEFAULT false, -- set true when target removed
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- Revit parameter mappings (Phase 4a). One Revit family instance fans out to
-- many paragraphs across many specs. The natural key uses NULLS NOT DISTINCT
-- (PG 15+) so family-instance-level rows (NULL component_role) collide
-- correctly under idempotent upsert. spec_id is intentionally NOT denormalized
-- here — derive via paragraphs.spec_id when filtering by spec.
CREATE TABLE revit_parameter_mappings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paragraph_id         UUID NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  revit_instance_id    TEXT NOT NULL,       -- Revit element GUID, stable per element
  revit_component_role TEXT,                -- 'faceplate' | 'jack' | 'conduit' | ...
                                            -- NULL = family-instance-level param
  revit_param          TEXT NOT NULL,       -- e.g. 'Manufacturer', 'PortCount'
  direction            VARCHAR(20) NOT NULL DEFAULT 'to_spec'
    CHECK (direction IN ('to_spec','to_revit','bidirectional','spec_only')),
  transform_type       VARCHAR(20) NOT NULL
    CHECK (transform_type IN ('replace','placeholder','append','prepend')),
  transform_config     JSONB,               -- Zod-validated in app layer (#47)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT
    (paragraph_id, revit_instance_id, revit_component_role, revit_param)
);
```

## Additional tables

Later migrations add these tables (see the migration files and cited ADRs for column detail):

| Table | Purpose | ADR / PR |
|-------|---------|----------|
| `division_general_specs` | Division-general context, library- and project-scoped | ADR-023 |
| `editing_conventions` | Built-in + library-scoped editability convention profiles | ADR-022 |
| `paragraph_associations` | Paragraph ↔ external document reference links | #242 |
| `required_sections` | Authored required-sections substrate (project + package scope) | ADR-028 |
| `keynotes` | Keynote master table + project-filtered query; exported as the tab-delimited Revit keynote table (`GET /projects/:id/keynotes`, `get_project_keynotes`) | ADR-016 |
| `header_footer_configs` | Scoped header/footer overrides (**foundation only**, no resolution/render yet) | ADR-017, ADR-040 |
| `numbering_profiles` | Saved structural numbering profiles, library-scoped | #299 |
| `revision_nomenclature_profiles` | Structured revision/addendum naming, built-in + project override | ADR-025 |

Concurrency/versioning also add advisory lock and lifecycle-state storage (ADR-018). Style storage moved to a JSONB payload on `style_rules` (ADR-021).

## Composite Revit identity

A single Revit family instance (e.g., "Data Outlet A") is rarely one parameter source: it contains multiple sub-components (faceplate, jack, conduit, backbox, cable), each with its own Revit parameters. The schema treats `(revit_instance_id, revit_component_role, revit_param)` as the source identity, with `revit_component_role = NULL` reserved for parameters defined at the family-instance level itself.

That same instance also fans out across **multiple specs**: a Data Outlet touches both Division 26 (pathways) and Division 27 (telecommunications). One Revit instance ID therefore appears on many `paragraph_id`s in different specs, retrieved via `getMappingsByInstance(...)`.

## Direction enum reserves bidirectional sync

`direction` enumerates four edge directions:

| Value | Meaning | Phase |
|-------|---------|-------|
| `to_spec` (default) | Revit value populates the spec paragraph | 4a — only direction implemented today |
| `to_revit` | Spec-authoritative value pushed back to Revit | reserved for #85 |
| `bidirectional` | Mutual sync — diff resolution required | reserved for #85 |
| `spec_only` | Spec is authoritative; Revit is advisory / read-only | reserved for #85 |

The check constraint blocks invalid values now so the write path in #47 can rely on the enum surface without re-validating.

## Deferred work building on this schema

| Concern | Tracked by |
|---------|-----------|
| `PATCH /specs/:id/paragraphs/:nodeId` endpoint that consumes mappings | #47 |
| Revit add-in (C#/.NET) scaffold that writes mappings via the REST API | #48 |
| Family-category → required MasterFormat sections registry + project preflight | #82 |
| Family-type-level mappings (`revit_family_type_id`) | #83 |
| Multi-Revit-model support (`revit_model_id`) | #84 |
| Bidirectional sync write path (`to_revit` / `bidirectional` / `spec_only`) | #85 |
