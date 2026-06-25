# ADR-036: Product-driven submittal register

## Status

Accepted

## Context

Issue #263 asks for a submittal table for a group of selected specs. The useful
deliverable is product-driven: contractors submit information about the products
and components specified in PART 2 - PRODUCTS, while PART 1 - SUBMITTALS states
which submittal types are required. The current AST has no persisted product,
material, manufacturer, or submittal entities; it has generic CSI structural
nodes plus derived `meta.articleRole` on article headings (ADR-033). Paragraph
associations (#109) already attach external datasheet links to Part 2 paragraphs.

The feature must therefore infer a register from existing AST shape without
pretending to have a complete product data model. Precision matters more than
recall: a smaller correct register is more useful than noisy NLP guesses.

## Decision

Add a read-only, computed-on-demand submittal register:

- `POST /projects/:id/submittal-register` with `{ specIds: string[] }` returns
  `ApiResponse<{ projectId, specIds, rows, findings, summary, notes }>` for the
  explicitly selected project specs. Empty selection is valid and returns an
  empty register. Specs outside the project are rejected.
- MCP tool `submittal_register` exposes the same computation for AI clients.
- The existing coordination report union gains three additive findings:
  `product_without_submittal_type`, `submittal_type_without_product`, and
  `product_missing_datasheet`.

### Submittal data model

A register row is:

- `productName`
- `requiredSubmittalTypes`
- `datasheets` from paragraph associations
- `datasheetStatus` (`present` or `missing`)
- `sources[]` with source spec id, section, title, paragraph id, and paragraph text

Rows are derived, not stored. No migration or cache is added.

### PART 2 product extraction heuristic

The extractor considers only the explicit Products part: part headings containing
`PRODUCTS` or beginning with `PART 2`. PART 3 mentions never become register rows.

Within PART 2:

- A non-generic direct `article` child is one product row.
- Generic articles such as `PRODUCTS`, `MATERIALS`, `MANUFACTURERS`, `GENERAL`,
  and `SOURCE QUALITY CONTROL` are not rows themselves; concise direct `pr1`/`pr2`
  product paragraphs beneath them may become rows.
- Paragraph product candidates are conservative: reject imperative sentences
  starting with words such as `provide`, `submit`, `install`, `coordinate`, and
  reject long sentences. If a paragraph uses `Name: description`, only `Name` is
  the product candidate.

KNOWN APPROXIMATION: This intentionally misses some real products in prose-heavy
specs. It does not try to identify manufacturers, model numbers, or every noun
phrase. Future article-role/product tagging can improve recall without changing
the register contract.

### PART 1 submittal type matching

Required types are read only from the PART 1 article whose `meta.articleRole` is
`submittals` (or whose heading derives that role). Recognized types are the CSI
common set used in UFGS-style submittals: Product Data, Shop Drawings, Samples,
Design Data, Test Reports, Certificates, and Operation and Maintenance Data.
Negated text such as "not required" is ignored.

Because the AST has no per-product submittal mapping, recognized types apply at
the spec level to every product row from that spec. If a product exists but no
type is recognized, emit `product_without_submittal_type`. If a type exists but
no PART 2 product candidate exists, emit `submittal_type_without_product`.

### Deduplication and grouping

Rows dedupe by normalized product name across the selected specs. Deduped rows
merge source provenance, datasheet associations, and the union of required
submittal types. This keeps identical products specified in multiple sections as
one contractor-facing row while preserving every source paragraph.

### Datasheet linkage

Datasheet evidence is the existing `meta.associations` collection on the product
paragraph/article and its descendants. No bytes are copied into the register.
When no association exists for a product candidate, emit `product_missing_datasheet`.

### PART 3 rule

PART 3 - EXECUTION product mentions are excluded from register rows and findings
in this PR. Optional supplementary PART 3 context can be added later as a
separate field, but it must never change the deliverable row set.

## Consequences

- The register is deterministic, testable, and uses existing AST plus association
  substrate. No product table or submittal table is introduced prematurely.
- The endpoint works for arbitrary selected spec groups instead of only the full
  project TOC, matching the PM workflow for partial packages.
- Coordination reports now surface product/submittal mismatches alongside the
  existing required/present/reference findings.
- The main limitation is recall: prose-heavy product requirements that are not
  article headings or concise product paragraphs may be omitted. This is
  deliberate and documented rather than hidden.

## Alternatives considered

- **Extract the PART 1 Submittals list as the register.** Rejected: it answers
  which submittal types are required, not which products the contractor must
  submit data for.
- **Persist product/submittal entities now.** Rejected: the current AST and UI do
  not have authoring semantics for products; persisting heuristic guesses would
  create stale pseudo-facts.
- **NLP product extraction over all Part 2 prose.** Rejected for v1: it would
  increase false positives and add an opaque behavior surface. The conservative
  structural heuristic can be improved later behind the same output contract.
- **Use PART 3 mentions as rows.** Rejected: execution paragraphs may reference
  products already specified elsewhere or mention installation context. They are
  supplementary evidence, not specified-product rows.
