# ADR-021: Extensible JSONB style storage, not rigid columns

## Status: Accepted

Supersedes the scalar-column storage model introduced by ADR (implicit) / migration `010`
under issue #30. Builds on ADR-003 (canonical CSI AST, not raw OOXML).

## Context

The product goal is round-trip DOCX with **visual style preserved**: a firm imports a
source-of-truth specification document, we capture its visual appearance, and we re-emit
documents that look like the source (plus the author's edits). The first concrete step is
deriving a firm **style template** from an imported DOCX (see the
`2026-06-09-docx-style-fidelity-roundtrip-design` spec).

Issue #30 (migration `010`, shipped) modelled `style_rules` as a fixed set of typed
columns: `font_family`, `font_size_half_pt`, `bold`, `caps`, `indent_twips`,
`space_before_twips`, `space_after_twips`, `numbering_format`.

OOXML paragraph and run properties (`w:pPr` / `w:rPr`) are **open-ended and explicitly
extensible**. Beyond the handful above there are paragraph borders (six sub-edges, each
with style/size/color/space), shading, multiple tab stops, contextual spacing, mirror
indents, character kerning and spacing, text effects, theme-linked fonts, East-Asian
typography — plus a formal extension element (`w:extLst`) for vendor and future additions.

A fixed column set can therefore only ever capture the subset we anticipated. When a
real source-of-truth document carries a property we did not model, a column schema has two
failure modes, both unacceptable for a fidelity feature:

1. **Silent truncation** — the property is dropped. We promised to preserve the source's
   appearance and instead quietly destroyed part of it.
2. **Hard failure** — an import path tries to persist something the table cannot hold and
   errors out. The "source of truth" import "booms."

And every newly encountered property becomes a schema migration — a treadmill, not a model.

This is not hypothetical. The existing UFGS-Default seed (migration `011`) already
extracted a real line-spacing value (`line=360`, 1.5×) from the source fixture and had
**no column to store it** — documented but discarded. The shipped schema is already lossy.

## Decision

Store each per-`NodeType` style rule's visual style as an **OOXML-faithful JSONB
payload**, replacing the scalar style columns. Concretely:

- `style_rules` keeps only its **structural** columns: `id`, `template_id`, `node_type`
  (plus the `(template_id, node_type)` unique constraint and the `node_type` CHECK). A
  new `properties jsonb NOT NULL DEFAULT '{}'` column holds the style definition.
- The JSON is a **lightly tidied mirror of `w:pPr` / `w:rPr`** plus a `numbering`
  section, in **native OOXML units** (half-points, twips, 240ths) — no lossy unit
  conversion. Example for `part`:

  ```jsonc
  {
    "rPr": { "rFonts": { "ascii": "Courier New" }, "sz": 20, "b": true, "caps": true },
    "pPr": { "spacing": { "before": 0, "after": 120 }, "ind": { "left": 0 } },
    "numbering": { "ilvl": 0, "numFmt": "decimal", "lvlText": "PART %1 -" }
  }
  ```

- **Validation is open, not closed.** A Zod schema types the keys we understand and
  **passes unknown keys through unchanged** rather than rejecting or stripping them.
  Nothing a real document contains can overflow the schema.
- **No max-bound rejection of captured values.** A 73pt heading is the author's truth, not
  an error. Capture faithfully; **warn**, never reject/clamp. (This retires the
  "max font size / max twips" DB-CHECK policy idea from the #30/#31 era for captured data.)
- The **generator applies the subset it can express** through `dolanmiu/docx`. Properties
  it does not yet map are **preserved in storage** (and may be raw-injected into OOXML in a
  later phase) rather than lost.
- **Byte-exact raw-OOXML round-trip is explicitly out of scope.** We never persist the
  source `.docx` as a raw artifact; the JSON definition *is* the translation. This keeps
  faith with ADR-003 — style lives as an OOXML-faithful **side-channel definition**, it is
  not folded into the canonical structural AST.
- The **same representation is reused** for the later per-paragraph and per-run *override*
  deltas (Layer 2), narrower in scope but identical in shape — one style vocabulary across
  template rules, paragraph overrides, and run spans.

## Consequences

**Positive**

- Lossless capture: unknown / exotic / future OOXML properties ride along automatically.
- Zero per-property migrations — adding support for a property is generator/Zod work, not
  a schema change.
- Footgun closed: a source-of-truth import can never overflow or be silently truncated by
  the schema.
- One unified style representation across all three fidelity layers.
- Honest separation of concerns: capture (lossless) vs. render (best-effort subset) vs.
  byte-exact (out of scope), each explicit.

**Negative / trade-offs**

- Per-column DB CHECK constraints on individual style values go away. Structural validation
  moves to the application layer (Zod) and is **advisory (warn) rather than rejecting** for
  captured values. The DB still owns the `node_type` enum and the structural uniqueness.
- SQL filtering on individual style properties now uses JSONB operators (`->`, `->>`,
  `@>`); add a GIN or expression index only if a real query need appears (none today).
- Requires a conversion migration (`014`): add `properties`, backfill it from the existing
  columns (and enrich UFGS-Default with the previously-unstorable `line=360`), then drop the
  scalar style columns. The down migration recreates the columns and back-projects.
- Reverses part of the shipped #30 design and reshapes the (unbuilt) #31 CRUD API to operate
  over the JSON payload.

**Neutral**

- `numbering_format` (a numbering concern, not a `pPr`/`rPr` property) moves into the
  payload's `numbering` section, where it can carry both `numFmt` and `lvlText` — strictly
  richer than the single string the column held.
- `note` / `continuation` / `spec` remain unstyleable for now (unchanged `StyleNodeType`
  set); adding `note` styling later is additive.
