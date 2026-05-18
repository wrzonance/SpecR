# ADR-012: UFGS Corpus is Reference Material, Not Authoritative CSI Standard

## Status: Accepted

## Context

The `spec_sections` table is seeded from the UFGS (Unified Facilities Guide Specifications) corpus — 665 `.SEC` files produced by the U.S. Army Corps of Engineers and related DoD agencies. UFGS specs are adapted from CSI MasterFormat but are not published by or endorsed by the Construction Specifications Institute.

The `lookupSpecSectionTitle` function queries this table to produce `standardTitle` values used in `InferenceWarning` and `sectionInference` MCP responses. LLM callers use `titleMatch` (`exact`/`close`/`divergent`) to decide whether to surface a verification prompt.

## Decision

UFGS section titles are treated as **reference material**, not as authoritative CSI MasterFormat definitions. Specifically:

- `standardTitle` in inference responses reflects the UFGS title for that section number, which may differ from the official CSI MasterFormat title published by CSI
- `titleMatch: 'close'` or `'exact'` does NOT mean the title matches the official CSI standard — it means the inferred title matches the UFGS reference for that section number
- LLM callers should communicate this provenance to users when surfacing inference results
- Future work may incorporate the authoritative CSI MasterFormat title database (licensed from CSI) as a separate lookup tier

## Consequences

- `note` strings in `InferenceWarning` and `sectionInference` responses explicitly state "UFGS reference" rather than "CSI standard"
- `titleMatch: 'unknown'` when a section is not found in `spec_sections` means only that UFGS does not publish a spec for that section — it does not mean the section number is invalid
- Division coverage: UFGS covers DoD-relevant divisions heavily (22, 26, 27, 28, 33) but has gaps in commercial/architectural divisions. Sections from ARCAT or CPI that fall outside UFGS coverage will always return `standardTitle: null`
- The `spec_sections` seed data remains valuable for fuzzy validation of inferred titles — it catches gross inference errors (e.g., confusing a section number from a table of contents with the actual section number). Its limitations are provenance, not utility.
