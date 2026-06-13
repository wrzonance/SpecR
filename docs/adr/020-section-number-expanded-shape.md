# ADR-020: Expanded Section-Number Shape as Opaque Normalized String

## Status: Accepted

## Context

CSI MasterFormat Level 4 (`26 00 13.10`) and UFGS Level 5 agency suffixes
(`01 32 01.00 10`; 10 = Army Corps, 20 = NAVFAC, 30/40 = NASA/AFCEC) appear in
36% of the UFGS reference corpus and arrive through every ingest format (.SEC,
DOCX, plaintext). SpecR previously validated only `NN NN NN`, silently
truncating suffixes in prose-ref extraction and content inference — collapsing
distinct sections (e.g. `01 33 23` vs `01 33 23.33`) into one identity.

Two viable designs:

1. Opaque normalized string, grammar owned by one module.
2. Structured `SectionNumber` type with decomposed DB columns
   (division/l2/l3/suffix/agency).

## Decision

Opaque normalized string (`src/lib/section-number.ts` owns the grammar).
Canonical form: single ASCII spaces, `NN NN NN`, `NN NN NN.NN`, or
`NN NN NN.NN NN`. Cross-reference linking remains **exact match only** — a ref
to `26 00 13` never resolves to `26 00 13.10` or vice versa. DB CHECK
constraints enforce shape on `specs.section` (plus the `'unknown'` inference
sentinel) and `spec_sections.section_number`;
`spec_references.target_spec_section` stays unconstrained because it records
what the source document said.

### Display variants and output policy

SpecR accepts common display variants only when the surrounding context already
identifies the token as a section number: `SECTION` headers/references,
`.SEC` `<SCN>`/`<SRF>` tags, DOCX core metadata, and validated API section
fields. Supported variants normalize before persistence:

- `NNNNNN`
- `NN.NN.NN`
- `NN NNNN`
- suffixed equivalents with an explicit dotted suffix, e.g.
  `013201.00 10` and `01.32.01.00 10`

Bare free-prose scanning remains canonical-only. Six-digit values in product,
model, catalog, and standards contexts are not section references without a
`Section`/`SECTION` cue or a tagged/API context.

Generated DOCX accepts a request-scoped `sectionNumberFormat` override:
`canonical`, `dots`, or `compact`. The override applies to the synthetic
`SECTION ...` title and confidently identified `Section ...` paragraph
references. Canonical AST and DB values are unchanged. Persistent client or
library convention profiles are deferred until there is a broader convention
profile model; the generate-request override is the current explicit policy
surface.

## Consequences

- One module to change when the grammar grows; consumers embed its fragment.
- Exact-match keeps broken refs honest (a base ref to a missing base section
  is genuinely broken) at the cost of no family fallback.
- Structured queries (e.g. "all agency variants of X") require LIKE prefixes
  rather than column equality — acceptable; no current feature needs them.
- Free-prose ambiguity: `Section 26 00 13.10 20 mm` mis-reads `20` as an
  agency suffix. Documented as KNOWN AMBIGUITY; tagged .SEC refs are immune.
- Lexicographic ORDER BY remains correct for the fixed-width grammar.
- Exact-match reference resolution improves for display variants because strong
  parser contexts store normalized `target_spec_section` values, but
  `spec_references` still does not split raw display text from canonical target
  spans. Generation therefore rewrites paragraph references by rescanning only
  confident `Section ...` text.
