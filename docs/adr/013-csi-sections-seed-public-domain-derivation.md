# ADR-013: spec_sections seed data derives exclusively from public-domain UFGS

> **Historical note:** This ADR's filename references the original table name `csi_sections`. Migration `009_rename_csi_sections_to_spec_sections` renamed the table to `spec_sections`. The filename is preserved for stable cross-references; the body has been updated to use the current name. All provenance guarantees below apply unchanged to the renamed table.

## Status: Accepted

## Context

The `spec_sections` PostgreSQL table (created in `src/db/migrations/001_create_csi_sections.ts` and renamed by `src/db/migrations/009_rename_csi_sections_to_spec_sections.ts`) stores section numbers, titles, and division IDs that follow the CSI MasterFormat® classification scheme. CSI, Inc. asserts copyright on MasterFormat numbers + titles + classifications, and its EULA forbids embedding "any portion of the CSI Product into commercial construction software" without written permission.

The copyright assertion itself is contested under the idea/expression dichotomy ([17 U.S.C. § 102(b)](https://www.law.cornell.edu/uscode/text/17/102)) and *Feist Publications, Inc. v. Rural Telephone Service Co.*, 499 U.S. 340 (1991) — facts are not copyrightable and copyright in a factual compilation reaches only original selection and arrangement, not the underlying facts. SpecR does not adjudicate the question; it avoids it by not sourcing from CSI publications.

SpecR ships open-source under MIT. If the seed contained content lifted from CSI publications, redistribution would violate the EULA regardless of license.

## Decision

The `spec_sections` seed is derived **exclusively** from the public-domain Unified Facilities Guide Specifications (UFGS) corpus under `docs/references/UFGS/`. Specifically:

1. `src/db/seed.ts` reads `.SEC` files from `docs/references/UFGS/DIVISION_*/`.
2. It extracts `<SCN>SECTION NN NN NN</SCN>` and `<STL>Title</STL>` tags via regex.
3. It upserts `(section_number, title, division)` triples into `spec_sections`.

No other data source feeds this table. The `docs/references/ARCAT/` and `docs/references/MANUFACTURER_CPI/` reference directories contain README-only stubs documenting how to obtain those third-party copyrighted specs for local testing; their content is **never committed** and **never feeds the seed**.

UFGS is a work of the U.S. Government (USACE / NAVFAC / AFCEC) and is in the public domain under [17 USC § 105](https://www.law.cornell.edu/uscode/text/17/105). UFGS follows CSI MasterFormat numbering because [UFC 1-300-02](https://www.wbdg.org/FFC/DOD/UFC/ARCHIVES/ufc_1_300_02_2014.pdf) requires it ("Comply with Construction Specifications Institute (CSI) MasterFormat® latest version"); the terms of whatever agreement exists between the federal government and CSI are not public.

§ 105 alone does not carry this decision: public-domain status of a government document does not strip copyright from third-party material embedded in it. SpecR's redistribution posture rests on narrower, verifiable grounds: (a) under *Feist*, an individual section-number ↔ title pairing is a fact; (b) under [17 U.S.C. § 102(b)](https://www.law.cornell.edu/uscode/text/17/102) and [37 CFR § 202.1(a)–(b)](https://www.ecfr.gov/current/title-37/section-202.1), numbering systems and short phrases (names, titles) are not copyrightable; and (c) the seed reproduces the UFGS corpus's DoD-driven selection of sections with UFGS's own titles — not CSI's selection, coordination, or arrangement, which is the only place *Feist* locates compilation copyright. See the taxonomy cases under Related precedent for the adverse and favorable authority on classification schemes.

## Consequences

- SpecR can redistribute the seeded table data without a CSI license: every row is a section-number/title fact taken from a public-domain UFGS document, and the table reproduces UFGS's selection of sections, not CSI's (see Decision for why § 105 alone is not the operative theory).
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

- [ADR-012](012-ufgs-as-reference-not-authoritative-csi.md) — UFGS positioned as reference data, not authoritative CSI MasterFormat
- [docs/references/UFGS/README.md](../references/UFGS/README.md) — UFGS corpus provenance

### Related precedent

- *Feist Publications, Inc. v. Rural Telephone Service Co.*, 499 U.S. 340 (1991) — facts are not copyrightable; copyright in a factual compilation extends only to original selection/arrangement, not the underlying facts. [Cornell LII](https://www.law.cornell.edu/supremecourt/text/499/340)
- 17 U.S.C. § 102(b) — copyright protection does not extend to any idea, procedure, process, system, method of operation, concept, principle, or discovery. [Cornell LII](https://www.law.cornell.edu/uscode/text/17/102)
- *Veeck v. Southern Building Code Congress Int'l, Inc.*, 293 F.3d 791 (5th Cir. 2002) (en banc) — held that model building codes lose copyright protection once enacted into law. The opinion's merger reasoning is tied to the codes-as-law context ("The building codes of Anna and Savoy, Texas can be expressed in only one way; they are facts."); the court expressly distinguished cases involving private standards merely *referenced* (not adopted) by legislation ("The copyrighted works do not 'become law' merely because a statute refers to them."). MasterFormat is neither enacted as law nor incorporated by reference into one (a full-text search of the eCFR returns zero hits for "MasterFormat" or "Construction Specifications Institute"), so Veeck's holding does not reach it. Cited for context on the broader public-domain-via-adoption line of cases, not as authority for SpecR's posture. [Full opinion via Public.Resource.Org](https://law.resource.org/pub/us/case/reporter/F3/293/293.F3d.791.99-40632.html)

### Taxonomy / numbering-scheme precedent

- *American Dental Ass'n v. Delta Dental Plans Ass'n*, 126 F.3d 977 (7th Cir. 1997) — **adverse authority**: held a code taxonomy (numbers, short descriptions, long descriptions) copyrightable under § 102(a). The same opinion limits its own reach: "Section 102(b) precludes the ADA from suing, for copyright infringement, a dentist whose office files record treatments using the Code's nomenclature" — *using* a taxonomy is not infringing it. [Full opinion via Public.Resource.Org](https://law.resource.org/pub/us/case/reporter/F3/126/126.F3d.977.96-4140.html)
- *Southco, Inc. v. Kanebridge Corp.*, 390 F.3d 276 (3d Cir. 2004) (en banc) — part numbers produced by mechanically applying a numbering system are not copyrightable; there is no protectable creativity in the resulting numbers. [Slip opinion (3d Cir.)](https://www2.ca3.uscourts.gov/opinarch/021243pe.pdf)
- *ATC Distribution Group, Inc. v. Whatever It Takes Transmissions & Parts, Inc.*, 402 F.3d 700 (6th Cir. 2005) — a parts classification scheme and its numbers are uncopyrightable ideas/systems under § 102(b); expressly skeptical of *American Dental*. [Opinion (Google Scholar)](https://scholar.google.com/scholar_case?case=11477627982436047743)
- *Practice Management Info. Corp. v. American Medical Ass'n*, 121 F.3d 516 (9th Cir. 1997) — copyright in a code set **survives** incorporation by reference into regulations (CPT in Medicare rules). Confirms the *Veeck* distinction, and cuts both ways for SpecR: governmental use of MasterFormat in UFGS does not by itself extinguish CSI's rights — which is exactly why this ADR rests on *Feist*/§ 102(b)/short-phrases grounds and on copying only the UFGS-published subset, rather than on any codes-as-law or public-domain-inheritance theory. [Abridged opinion (Harvard Berkman Center)](https://cyber.harvard.edu/people/tfisher/IP/1997%20PMI%20Abridged.pdf)
