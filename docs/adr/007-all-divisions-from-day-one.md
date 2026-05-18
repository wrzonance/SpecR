# ADR-007: All CSI Divisions From Day One

## Status: Accepted

## Context

The initial use cases driving SpecR are Division 27 (Communications) and Division 28 (Electronic Safety and Security) — the divisions where the Revit-to-spec workflow is most manual and the data is most structured. It would be faster to build a Division 27/28-specific tool first and generalize later.

Division-specific approaches fail at the data model level: CSI section numbers, the PART/ARTICLE/PR hierarchy, and the numbering format are universal across all divisions. A data model that hard-codes Division 27 assumptions would need to be refactored to add Division 03 (Concrete), which is a different team's problem and creates a worse outcome for them.

The UFGS corpus covers 31 divisions (666 files). Using it as seed data for a Division-27-only tool wastes the most valuable aspect of the public domain corpus.

## Decision

The data model, parser, and generator are division-agnostic from day one. No division-specific code in the core. CSI section numbers are data (stored in a reference table), not code.

The only division-specific content is the UFGS seed data — and that is also loaded for all available divisions, not filtered.

Phase 4 Revit integration will be implemented for Division 27/28 first (because that's where the Revit families and parameter mappings exist for testing), but the Revit mapping schema is also division-agnostic.

## Consequences

- The CSI section reference table (`spec_sections`: `section_number`, `division`, `title`) is seeded for all MasterFormat 2020 divisions at project initialization. This is a one-time data import, not ongoing work.
- No `if division === 27` branches exist in src/. Division is metadata on a spec, not a code path.
- The inference engine is tested against ARCAT specs from Division 01 through 40, not just Division 27/28. The UFGS fixtures provide coverage across all 31 seeded divisions.
- "We only support Division 27" is never a valid scope limit. "We have not yet loaded Revit parameter mappings for Division 03" is a valid current state.
