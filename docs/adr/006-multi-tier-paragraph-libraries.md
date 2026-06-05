# ADR-006: Multi-Tier Paragraph Libraries

## Status: Superseded by [ADR-015](015-layered-spec-hierarchy-chain-of-custody.md)

> ADR-015 restates the valid core of this ADR (tier separation; public-domain/firm-IP
> isolation) and specifies the schema this ADR promised but never shipped
> (`parent_library_id` / tier columns) — adding the client-master tier, owned project
> copies, design packages, issuance revisions, and chain-of-custody lineage. The style
> tier shipped separately as `style_templates` / `style_rules` (Phase 2c).

## Context

Construction specification firms maintain master paragraph libraries — collections of pre-written, reviewed paragraphs organized by CSI division and section. A project spec is assembled by selecting paragraphs from the master library, editing them for project specifics, and adding project-unique content.

The simplest model is a flat library per firm: one set of paragraphs, all projects share it. This fails when:
- Firms want to use public domain content (UFGS) as a starting point without mixing it with their proprietary work
- Different projects need different style templates (formatting/branding)
- Revit model data must populate specific paragraphs without being written into the master library

An alternative is per-project databases with no shared inheritance. This eliminates reuse — firms would re-author the same paragraphs for every project.

## Decision

Four-tier library hierarchy with explicit inheritance:

```
Seed tier     ← UFGS public domain content (optional, firm can ignore)
    ↓ inherits
Firm tier     ← Master paragraph library per division/section (firm's IP)
    ↓ inherits
Style tier    ← DOCX output template (fonts, margins, numbering format, header/footer)
    ↓ applies
Project tier  ← Project-specific overrides + Revit-injected content
```

- **Seed tier:** UFGS .SEC corpus, parsed into the database. Firms may adopt seed paragraphs into their firm library or ignore the tier entirely.
- **Firm tier:** The firm's master library. Paragraphs here are shared across all projects. Changes here propagate to new projects (not retroactively to existing ones — projects lock their versions at creation).
- **Style tier:** The DOCX style template defines presentation only, not content. Swapping the style template produces a different-looking DOCX from the same AST.
- **Project tier:** Project-specific overrides. A Revit parameter injection populates a paragraph at the project tier without modifying the firm library. A project can add paragraphs, override firm paragraphs, or suppress them.

## Consequences

- MVP does not implement multi-tier library management. Phase 0–3 work with a single flat spec. The **data model must support the hierarchy from day one** (parent_library_id, tier columns) even if Phase 1 doesn't use them.
- The legal separation between tiers matters: UFGS content (public domain) must never be mistakenly presented as the firm's proprietary work. The `source` field on `SpecNode` and `paragraphs.source` column enforce this.
- Revit parameter injection (Phase 4) populates project-tier paragraphs, not firm-tier paragraphs. A Revit model change updates the project spec, not the master library.
- Style template configuration (Phase 5) replaces the single hardcoded CSI MasterFormat/ARCAT output format used in MVP.
