# ADR-015: Layered Specification Hierarchy and Chain of Custody

## Status: Proposed (Phase 2d — not yet implemented)

> Supersedes ADR-006. Restates its still-valid core (tier separation; legal isolation of
> public-domain content from firm IP) and replaces the unbuilt schema sketch with a
> concrete model: libraries, owned project copies, design packages, issuance revisions,
> and a traceable derivation chain. The style tier from ADR-006 is unaffected — it
> shipped separately as `style_templates` / `style_rules` (Phase 2c, #30).

## Context

ADR-006 defined a four-tier library hierarchy (seed → firm → style → project) and required
that "the data model must support the hierarchy from day one (parent_library_id, tier
columns)". Those columns were never added. The current model:

- A spec is `(section, title, source)` with `UNIQUE (section, source)` — one global
  namespace (`migrations/002`, `005`).
- Projects alias shared rows: `addSpecToProject` inserts a `project_specs` join row
  pointing at the same library spec every other project sees
  (`src/db/queries/projects.ts`). Editing a "project" section mutates the global row.
- The only provenance field is `specs.source` (`ufgs|arcat|cpi|unknown`) — which file
  format / authoring template a spec was parsed from, not where its content derives from.
- `paragraph_versions` and `base_version` exist as schema but no code reads or writes them.

Real firms do not work in one namespace:

1. **Company master** — the firm's house standard, curated, edited rarely.
2. **Client master** — per-owner variant derived from the company master ("this client
   always wants X"), or ingested wholesale from the client's own spec set.
3. **Project** — one job; pulls sections from the applicable masters and diverges freely.
4. **Design package** — within one project, multiple issuable subsets ("Bid Package 1 —
   Sitework", "Early Steel Release", "100% CD set").
5. **Package revision** — each package is issued repeatedly ("50% DD", "100% CD",
   "Addendum 2"); each issuance is a point-in-time record with liability weight: the firm
   must be able to prove exactly what was issued, when, derived from what.

Cross-cutting all five: **chain of custody** — for any spec (or paragraph), trace where it
originated: which master, at which version, when it diverged, what file it was ingested
from.

## Decision

### D1 — Libraries are first-class rows; tiers are data

```sql
CREATE TABLE libraries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier               VARCHAR(20) NOT NULL
    CHECK (tier IN ('reference','company','client')),
  name               TEXT NOT NULL UNIQUE,
  owner              TEXT,                          -- firm/client identity; NULL for built-ins
  parent_library_id  UUID REFERENCES libraries(id), -- client master → company master (nullable)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE specs ADD COLUMN library_id UUID REFERENCES libraries(id);
ALTER TABLE specs ADD COLUMN project_id UUID REFERENCES projects(id);
-- a spec is a master (library_id) XOR a project working copy (project_id)
ALTER TABLE specs ADD CONSTRAINT specs_owner_xor
  CHECK ((library_id IS NULL) <> (project_id IS NULL));
```

- The `reference` tier preserves ADR-006's seed tier and ADR-013's legal separation: the
  UFGS corpus migrates into a read-only `UFGS Reference` library, never mingled with firm
  IP. A client master may parent to a company master (derived) or stand alone (ingested
  directly) — `parent_library_id` is nullable.
- `UNIQUE (section, source)` is replaced by two partial unique indexes:
  `UNIQUE (section, source, library_id)` for masters and `UNIQUE (section, project_id)`
  for project copies (a project TOC holds one instance of a section).

### D2 — Copy-on-derive with drift visibility (no silent propagation)

Pulling a section from a master into a client master or a project **clones** the spec row
and its paragraph tree, then records lineage:

```sql
ALTER TABLE specs ADD COLUMN parent_spec_id  UUID REFERENCES specs(id);  -- derivation edge
ALTER TABLE specs ADD COLUMN origin_version  INTEGER;          -- parent content_version at clone time
ALTER TABLE specs ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1; -- bumps on content writes
ALTER TABLE specs ADD COLUMN origin_meta     JSONB;            -- ingest provenance: filename, sha256, loader
```

- Edits hit only the copy. Master updates never propagate automatically — an issued spec
  can never change retroactively underneath a project.
- Drift is *visible*: `GET /specs/:id/lineage` walks the `parent_spec_id` chain and
  reports `{ chain, behindBy }` per hop, computed from the parent's current
  `content_version` against the stored `origin_version`.
- An explicit re-pull/rebase command (adopt selected upstream changes via the Phase 3 diff
  machinery) is a planned follow-up, out of this ADR's scope.
- `content_version` (spec grain, drift) is distinct from `base_version` (paragraph grain,
  ADR-005 merge). They coexist; they answer different questions.

### D3 — Multi-source project resolution

Projects are created with an **ordered source list** — company masters only, a client
master only, or both with fallback:

```sql
CREATE TABLE project_sources (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  library_id  UUID NOT NULL REFERENCES libraries(id),
  priority    INTEGER NOT NULL,
  PRIMARY KEY (project_id, library_id),
  UNIQUE (project_id, priority)
);
```

Adding a section resolves **per section**, walking the list: the first library holding the
section wins → clone → `parent_spec_id` points at the actual source row. A project
therefore natively mixes origins (client master for 09 51 00, company master for a section
the client lacks), and custody stays exact per section. When a section exists in multiple
sources, resolution is deterministic (priority order) and the shadowed alternative is
surfaced as an advisory, never silently dropped.

### D4 — Design packages: issuable subsets

```sql
CREATE TABLE design_packages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE package_specs (
  package_id  UUID NOT NULL REFERENCES design_packages(id) ON DELETE CASCADE,
  spec_id     UUID NOT NULL REFERENCES specs(id) ON DELETE RESTRICT,
  position    INTEGER NOT NULL,
  PRIMARY KEY (package_id, spec_id)
);
```

`project_specs` remains the project's full TOC (now pointing at the project's own copies);
packages subset and re-order it. One section may appear in multiple packages (an early
steel release and the full CD set both carry 05 12 00).

### D5 — Package revisions: immutable issuance snapshots

```sql
CREATE TABLE package_revisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id  UUID NOT NULL REFERENCES design_packages(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,            -- '50% DD', '100% CD', 'Addendum 2'
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (package_id, label)
);

CREATE TABLE package_revision_specs (
  revision_id UUID NOT NULL REFERENCES package_revisions(id) ON DELETE CASCADE,
  spec_id     UUID NOT NULL REFERENCES specs(id),
  position    INTEGER NOT NULL,
  tree        JSONB NOT NULL,           -- frozen SpecTree at issuance (lossless, Zod-validated)
  PRIMARY KEY (revision_id, spec_id)
);
```

Issuing a revision snapshots the full `SpecTree` of every section in the package — the
same lossless JSONB AST serialization ADR-011 designates for disaster recovery. The
snapshot is immutable: re-rendering "what we issued at 100% CD" is reproducible forever.
This reuses the `paragraph_versions` *pattern* at package grain without touching that
table — Phase 3 (#36) remains its first and only writer; merge snapshots and issuance
snapshots stay separate concerns at separate grains.

### D6 — Custody chain is the product of D1–D5, not a separate subsystem

For any paragraph in an issued manual, the chain reads:

```text
ingested file (origin_meta: filename, sha256, loader)
  → reference/company master spec (library, owner, content_version)
    → client master copy (parent_spec_id, origin_version)
      → project copy (parent_spec_id, origin_version, project_sources order)
        → package_revision_specs snapshot (label, issued_at)
```

Surfaced via `GET /specs/:id/lineage` and an MCP tool/resource so humans and AI agents can
audit provenance. ADR-011's git branch structure (`firm/`, `project/<id>`) mirrors this
hierarchy in serialized form; revisions map naturally to git tags. The relational model
and the branch structure must stay isomorphic.

## Consequences

- **Behavioral break:** `addSpecToProject` changes from alias to clone. Existing projects
  are backfilled by migration (aliased rows cloned into owned copies, lineage pointing at
  the original) so all projects land on uniform semantics.
- **The uniqueness key widens.** Everything relying on `UNIQUE (section, source)` — the
  `persistParsedSpec` upsert path — becomes library-scoped. Ingest now targets a library:
  `POST /parse`, `parse_document`, and `load_files` gain an optional `libraryId`
  (defaults: firm company master for authored content; the reference library for corpus
  loads).
- **Cross-reference resolution becomes scope-aware.** Refs inside a project copy resolve
  preferentially to that project's copies, then fall back to its source libraries.
- **Storage grows** by one paragraph-tree clone per project section and one JSONB tree per
  (revision, section). Text rows are small; bounded by issuance frequency. Acceptable.
- **No automatic propagation** is a feature with a cost: master fixes reach existing
  projects only via the future explicit re-pull. The lineage endpoint's `behindBy` makes
  that debt visible instead of silent.
- **Phase placement:** Phase 2d — after 2c (style templates), before Phase 3 (merge), so
  the merge engine is built once against the final model instead of retrofitted. Unblocks
  library-management UI (#42); prerequisite for project-manual issuance (ADR-017) and the
  document state model (ADR-018).
- **MCP write tools (#44) and auth/multi-tenant (#43)** acquire a natural authorization
  grain: library ownership and tier (a client login sees its client master and its
  projects, never the firm's company-master internals).

## Phase 2d breakdown

| Sub | Deliverable | Gates on |
|---|---|---|
| 2d-i | `libraries` table + tiers + `library_id` on specs + backfill migration | — |
| 2d-ii | lineage columns (`parent_spec_id`, `origin_version`, `content_version`, `origin_meta`) | 2d-i |
| 2d-iii | copy-on-derive `addSpecToProject` + `project_sources` resolution + scoped uniqueness | 2d-i, 2d-ii |
| 2d-iv | `design_packages` + `package_specs` | 2d-iii |
| 2d-v | `package_revisions` + issuance snapshots | 2d-iv |
| 2d-vi | lineage surfacing — REST endpoint + MCP tool/resource | 2d-ii |

## Alternatives considered

- **Live inheritance with override deltas** (project references master; stores only
  changed paragraphs). Rejected: every read needs an override-resolution layer; a master
  edit can change issued documents retroactively unless every issuance is separately
  snapshotted anyway; and merge semantics (ADR-005) become ambiguous when the base itself
  moves. Copy plus visible drift is simpler and safer.
- **Tier/owner columns directly on `specs`** (no `libraries` table). Rejected: client
  masters need first-class identity — a name, an owner, their own parent lineage — and
  `project_sources` needs a stable row to reference.
- **Per-project databases or schemas.** Rejected: kills cross-project search, the shared
  reference corpus, and the single-API model (ADR-002).
- **Storing issuances only as generated DOCX blobs.** Rejected as the primary record:
  opaque to diffing and MCP. JSONB AST is lossless and queryable; rendered-artifact
  caching remains a separate concern (#52).

## Related

- ADR-006 (superseded), ADR-005 (paragraph-grain merge versioning), ADR-011 (git mirror),
  ADR-013 (public-domain isolation → `reference` tier), ADR-017 (renders issuances),
  ADR-018 (lifecycle state set at issuance)
