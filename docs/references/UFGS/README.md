# UFGS (Unified Facilities Guide Specifications)

These specifications are works of the United States Government (USACE / NAVFAC / AFCEC) and are in the public domain under [17 USC 105](https://www.law.cornell.edu/uscode/text/17/105).

Files are in SpecsIntact XML format (.SEC), not DOCX. The hierarchy is encoded directly in the XML tree structure (`<PRT>`, `<SPT>`, `<TXT>`, `<LST>`/`<ITM>`, `<NTE>`).

## Source

Downloaded from the [Whole Building Design Guide (WBDG)](https://www.wbdg.org/dod/ufgs).

## Note on Referenced Standards

UFGS documents reference third-party standards (ASTM, NFPA, IEEE, TIA, etc.) by citation. Those referenced standards remain under their respective copyrights and are not included here. Only the UFGS government-authored content is present in these files.

## Format

SpecsIntact XML (.SEC) using the schema at `http://si.ksc.nasa.gov/sidownloads/xml/specsintactSEC.xsd`

Key elements:
- `<PRT>` — Part (contains `<TTL>` title)
- `<SPT>` — Sub-Part / Article
- `<TXT>` — Body text
- `<NTE>` / `<NPR>` — Specifier notes
- `<LST>` / `<ITM>` — Lists and items
- `<MET>` / `<ENG>` — Metric/English unit alternatives
- `<TAI>` — Service branch tailoring options
- `<RID>` — Reference identifiers
- `<SRF>` — Section cross-references

## Use in SpecR

UFGS is the **sole** source for the `spec_sections` reference table seed. See [ADR-013](../../adr/013-csi-sections-seed-public-domain-derivation.md).
