# ADR-013: spec_sections seed data derives exclusively from public-domain UFGS

> **Historical note:** This ADR's filename references the original table name `csi_sections`. Migration `009_rename_csi_sections_to_spec_sections` renamed the table to `spec_sections`. The filename is preserved for stable cross-references; the body has been updated to use the current name. All provenance guarantees below apply unchanged to the renamed table.

## Status: Accepted

## Context

The `spec_sections` PostgreSQL table (created in `src/db/migrations/001_create_csi_sections.ts` and renamed by `src/db/migrations/009_rename_csi_sections_to_spec_sections.ts`) stores section numbers, titles, and division IDs that follow the CSI MasterFormat® classification scheme. CSI, Inc. asserts copyright on MasterFormat numbers + titles + classifications, and its EULA forbids embedding "any portion of the CSI Product into commercial construction software" without written permission.

The copyright assertion itself is contested under the merger doctrine ([17 U.S.C. § 102(b)](https://www.law.cornell.edu/uscode/text/17/102)) and *Feist Publications, Inc. v. Rural Telephone Service Co.*, 499 U.S. 340 (1991) — facts and short functional designations are generally outside copyright. SpecR does not adjudicate the question; it avoids it by not sourcing from CSI publications.

SpecR ships open-source under MIT. If the seed contained content lifted from CSI publications, redistribution would violate the EULA regardless of license.

## Decision

The `spec_sections` seed is derived **exclusively** from the public-domain Unified Facilities Guide Specifications (UFGS) corpus under `docs/references/UFGS/`. Specifically:

1. `src/db/seed.ts` reads `.SEC` files from `docs/references/UFGS/DIVISION_*/`.
2. It extracts `<SCN>SECTION NN NN NN</SCN>` and `<STL>Title</STL>` tags via regex.
3. It upserts `(section_number, title, division)` triples into `spec_sections`.

No other data source feeds this table. The `docs/references/ARCAT/` and `docs/references/MANUFACTURER_CPI/` reference directories contain README-only stubs documenting how to obtain those third-party copyrighted specs for local testing; their content is **never committed** and **never feeds the seed**.

UFGS is a work of the U.S. Government (USACE / NAVFAC / AFCEC) and is in the public domain under [17 USC § 105](https://www.law.cornell.edu/uscode/text/17/105). The numbering scheme used by UFGS follows CSI MasterFormat conventions under a separate arrangement between the federal government and CSI; SpecR inherits the public-domain status by parsing UFGS rather than CSI's own publications.

## Consequences

- SpecR can redistribute the seeded table data without a CSI license, because every row originated in a public-domain UFGS document.
- The coverage of `spec_sections` is bounded by UFGS coverage: divisions and sections the federal government does not publish are absent from the table. This is acceptable; the seed is reference data for parser/MCP convenience, not an authoritative MasterFormat index. The deliberate incompleteness of `spec_sections` relative to CSI's published MasterFormat is itself evidence that this seed is a UFGS-derived dataset, not a MasterFormat clone. A reviewer can confirm this by comparing `spec_sections` row coverage against the UFGS corpus under `docs/references/UFGS/`.
- The MCP tool description `list_sections` and resource `specr://sections` reference "CSI MasterFormat" in nominative use to identify the numbering scheme — this is descriptive fair use, not a claim of authoritative MasterFormat content.
- Future seed additions MUST come from public-domain or properly-licensed sources only. Adding a CSI-sourced publication, MasterSpec content, or any other copyrighted reference dataset to the seed pipeline would invalidate this ADR and require revisiting.

## Verification

```bash
# Confirm src/db/seed.ts is the only writer to spec_sections
grep -rn 'INSERT INTO spec_sections' src/

# Confirm ARCAT and CPI dirs document "Not Included" status
cat docs/references/ARCAT/README.md
cat docs/references/MANUFACTURER_CPI/README.md

# Confirm seed reads from UFGS only
grep -n "UFGS_DIR\|docs/references" src/db/seed.ts
```

## Related

- [TRADEMARKS.md](../../TRADEMARKS.md) — full trademark and copyright notices
- [ADR-012](012-ufgs-as-reference-not-authoritative-csi.md) — UFGS positioned as reference data, not authoritative CSI MasterFormat
- [docs/references/UFGS/README.md](../references/UFGS/README.md) — UFGS corpus provenance

### Related precedent

- *Feist Publications, Inc. v. Rural Telephone Service Co.*, 499 U.S. 340 (1991) — facts are not copyrightable; copyright in a factual compilation extends only to original selection/arrangement, not the underlying facts. [Cornell LII](https://www.law.cornell.edu/supremecourt/text/499/340)
- 17 U.S.C. § 102(b) — copyright protection does not extend to any idea, procedure, process, system, method of operation, concept, principle, or discovery. [Cornell LII](https://www.law.cornell.edu/uscode/text/17/102)
- *Veeck v. Southern Building Code Congress Int'l, Inc.*, 293 F.3d 791 (5th Cir. 2002) (en banc) — alternative merger-doctrine holding relevant to industry numbering schemes; the adopted-into-law holding does not apply to MasterFormat. [Justia](https://law.justia.com/cases/federal/appellate-courts/F3/293/791/521953/)
