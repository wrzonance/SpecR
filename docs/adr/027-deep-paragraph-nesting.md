# ADR 027: Deep Paragraph Nesting

## Status

Accepted

## Context

SpecR originally modeled the CSI section hierarchy as seven DOCX numbering
levels: `part`, `article`, and `pr1` through `pr5`. That matches the normal CSI
MasterFormat convention documented in the architecture spec.

The UFGS reference corpus has at least one real `.SEC` file with a sixth
paragraph tier, and DOCX inputs can carry numbered list levels deeper than
`pr5`. Word's built-in multilevel numbering model is capped at nine levels, so a
single generated DOCX can represent `part`, `article`, and at most seven
paragraph tiers without inventing a second numbering definition and changing the
round-trip shape.

CSI does not define labels for `pr6` or `pr7`.

## Decision

SpecR supports two additional styleable AST node types: `pr6` and `pr7`.

Generated DOCX stays within Word's nine-level numbering limit:

- `part` -> level 0
- `article` -> level 1
- `pr1` through `pr7` -> levels 2 through 8

For the two non-CSI tiers, SpecR repeats the final established CSI paren pair:

- `pr6` uses decimal paren labels, `1)`
- `pr7` uses lowercase-letter paren labels, `a)`

The distinguishing signal for these tiers is depth and indentation, not a new
label shape. Parser mappings cap at `pr7`; levels beyond that remain outside the
DOCX generator contract until a future design chooses a conflict/reporting model
or a multi-numbering strategy.

## Consequences

Deep real-world specs can round-trip through the canonical AST and DOCX output up
to Word's native depth limit.

The repeated label shapes are intentionally conservative: they avoid presenting a
new "SpecR convention" as if CSI had standardized it. They can still be visually
distinguished in DOCX by the deeper list level and indentation.

Documents deeper than `pr7` are still lossy. DOCX parsing treats levels beyond
the supported sequence as continuations, and `.SEC` parsing saturates deeper SPT
depths at `pr7`. A future inference-conflict workflow can make those cases
explicit if real fixtures require it.
