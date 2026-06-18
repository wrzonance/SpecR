# ADR-017: Project-Manual Publishing and Assembly

## Status: Proposed (not yet scheduled — issuance path depends on Phase 2d revisions)

## Context

The generator renders exactly one section per call (`generateDocx(tree)`), and the project
model holds an ordered TOC (`project_specs`). What firms actually issue is a **project
manual**: cover page, table of contents, then every section in MasterFormat order with
consistent headers/footers carrying the project identity and the issuance label — plus
addenda, which reissue only the changed sections under an addendum cover.

Nothing renders that today: no multi-section DOCX, no cover, no TOC page, no addenda.
Revision naming is now profile-driven (ADR-025 / #209): publishing consumes the
revision's stored `displayName`, `number`, `type`, `date`, and open `attributes` rather
than parsing a freeform label. Header/footer extraction and inference are deliberately
split out to #208; this ADR stays about assembly/rendering.

## Decision

### D1 — An assembly engine in the generator module

A pure function over data the DB already holds:

```text
generateManual(project, package?, revision?)
  → cover page (project metadata + style template)
  → TOC (Word TOC field over section headings — Word computes page numbers on open;
     SpecR does not paginate)
  → for each section in order: existing per-section emitters,
     OOXML section break, per-section headers/footers (section number + issuance label)
  → single DOCX buffer
```

### D2 — Drafts render live; issuances render from snapshots

A draft manual renders from current DB state. An issued manual renders from a
`package_revision` snapshot (ADR-015 D5) — re-rendering any past issuance is reproducible
from the frozen AST. Publishing is a _view_ over the revision model, never a parallel
source of truth.

### D3 — Addenda are revision diffs

An addendum = a new revision whose rendered form includes only sections changed since the
referenced base revision, under an addendum cover listing the affected sections.
Section-level change detection (AST inequality between snapshots) suffices for v1;
paragraph-level change marking can later reuse the Phase 3 diff engine.

### D4 — `w:sdt` anchors are preserved throughout (ADR-004)

Every paragraph in a manual carries its UUID anchor, so a redlined _manual_ can re-enter
the Phase 3 round-trip and be split back to its constituent specs by anchor → spec
mapping.

## Consequences

- **Multilevel numbering must restart per section** — one numbering instance per section
  rather than one per document. This is the known sharp edge of this ADR:
  dolanmiu/docx numbering definitions are document-scoped, so per-section instances need
  distinct abstractNum references.
- TOC page numbers are Word-computed (TOC field), not SpecR-computed. Deterministic tests
  assert structure (field codes, entries, order), not pagination.
- Large manuals are CPU-heavy; this is the real driver for the DOCX cache (#52), which
  becomes a consumer of `content_version` invalidation (ADR-015/018) rather than its own
  locking design.
- Single-DOCX manual is v1. Per-section file emission (a zip of per-section DOCX files)
  is a cheap variant on the same engine — backlog.
- PDF output is out of scope (firms print to PDF from Word); see ADR-019 for the scope
  posture.
- Revision nomenclature is data, not a rendering enum. Manual headers/footers and
  addendum covers use the resolved revision identity from ADR-025; client/project naming
  differences are handled by the nomenclature profile, not hardcoded in the generator.

## Related

- ADR-015 (packages + revisions), ADR-004 (anchors), ADR-018 (state at issuance),
  ADR-019 (scope), ADR-025 (revision nomenclature profiles), #52 (cache), #84 extension
  (coordination report consumes the same project model), #208 (header/footer foundation)
