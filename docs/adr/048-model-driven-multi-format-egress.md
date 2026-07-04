# ADR-048: Model-driven multi-format egress — normalize, don't photocopy

## Status

Proposed (2026-07-03).

Governs the architecture and normalization policy for all rendered output (DOCX, PDF, Markdown,
HTML, `.SEC`). The concrete PDF rendering engine (pdfmake) and the stamped TOC-register table model
are decided in the #352 design doc / a follow-on rendering-approach ADR; they sit *inside* the policy
this ADR sets.

Depends on: ADR-021 (style templates / JSONB style substrate), ADR-026 (openapi as authoritative
contract), ADR-045 (MCP/API capability tiers). Relates to: #352 (PDF egress), the onboarding /
style-import phase, #150 (pixel-diff parity harness), #301/ADR-040 (header/footer fidelity).

## Context

- The canonical CSI **AST is the source of truth** (ARCHITECTURE.md), and it already renders to DOCX,
  Markdown, `.SEC`, and JSON. PDF (#352) and HTML are additive renderers, not a new source of truth.
- Real-world DOCX is messy. Spec writers hardcode article/paragraph numbers as literal text
  (`"1.01 Submittals"`), override paragraph/character styles with one-off direct formatting, and
  hand-fake multi-level lists. The 5-signal inference engine already recovers not just the CSI
  hierarchy but the intended **style hierarchy**, and persists losing signals to `paragraphs.conflicts`
  (`NOT NULL DEFAULT '[]'`) so every inference decision is auditable.
- The "one source of truth for DOCX **and** PDF" requirement reduces to: both must render from the
  *same resolved model*, or they drift.
- Load-bearing realization: OOXML paragraph/run/numbering styling is a **finite, enumerable** property
  space (fonts, sizes, weight, color, spacing, indent/hanging, alignment, tabs, per-level numbering
  format, `sectPr`, header/footer). A *complete* decomposition is therefore **lossless** — rendering
  DOCX from the resolved model equals passthrough fidelity. The only irreducible DOCX↔PDF residual is
  engine-level layout (line-breaking, hyphenation, pagination), which no model fixes and which the
  agreed **semantic** parity bar already excuses.
- But normalization must not be blind. Authors sometimes bold/underline **intentionally** — to mark an
  item that needs editing, or for genuine emphasis — and a client's house style may deliberately
  deviate from CSI defaults. Stripping every mark as "junk" would destroy meaning.

## Decision

1. **All formats render from the resolved model.** A format-neutral `resolveRenderModel` (AST +
   resolved style template + numbering resolution + header/footer) feeds every renderer. **No renderer
   receives raw OOXML** — the PDF engine never sees a `.docx`. DOCX is a *peer consumer* of the model,
   not a privileged passthrough.

2. **Passthrough is rejected.** Re-emitting the ingested `styles.xml`/`numbering.xml` verbatim would
   (a) reproduce the author's mistakes and (b) drift from every other format, since a template change
   would move PDF/Markdown/HTML but not the passthrough DOCX. Because the style space is enumerable,
   model-driven DOCX loses no fidelity that matters — so passthrough carries only cost, no benefit.

3. **Normalize, don't photocopy.** The target is fidelity-**to-intent**, not fidelity-to-artifact.
   Hardcoded numbers are recognized as labels, stripped, and **regenerated** from the canonical
   numbering (Word list field for DOCX, computed `getLabel` for PDF/Markdown). Direct-format overrides
   map to the **canonical style-per-node-type**. Prose content is preserved verbatim. The messy input
   is the *worst* parity reference; the resolved model is the reference of record. The output can be
   **cleaner than any input**, and the formats agree because they derive from one clean truth.

4. **Parity is measured model↔renderers, not output↔input.** The pixel-diff harness (#150) asserts
   **SpecR-DOCX vs SpecR-PDF** (both from the model) — never SpecR-output vs the original upload.
   Comparing to the messy input would measure divergence from garbage and call it a defect.

5. **Corrections are audited.** Every normalization decision (a stripped number, a discarded override)
   is recorded in `paragraphs.conflicts`, so "we cleaned X" is reviewable and reversible — this is what
   makes "cleaner" *trustworthy* rather than presumptuous. Renumbering is reference-aware: internal
   cross-references ride the UUID content-control anchors, so they survive a renumber; the canonical
   number is authoritative, and the conflict log shows where SpecR corrected the author.

6. **Client-scoped normalization levers (the onboarding style-fidelity engine).** Normalization is
   **governed by scoped rules**, not hardcoded:
   - **Defaults clean up junk** — stray highlights, underlines, and bold that don't match a
     paragraph's true (node-type) style are stripped.
   - **Intentional emphasis is semantic.** A client or company-master may declare **deviation rules**
     that *preserve* rather than strip — e.g. "underline ⇒ editable-token," "bold ⇒ emphasis to
     retain," "this run style is our house body font." Rules follow the scoped-profile pattern
     (firm → client → company-master → project → package → revision) and are resolved by scope at
     render time.

7. **Unresolved-style warning surface.** The onboard-a-DOCX-as-style phase **emits warnings for text
   styles that did not resolve** to a known node-type / style rule — surfaced, never silently dropped —
   so the operator can map them, accept the default cleanup, or add a deviation rule.

8. **Opt-in custom fonts/styles, API-exposed.** Resolution offers options to **enable custom fonts /
   preserve custom styles**. These options, and the scoped deviation rules above, are **exposed through
   the API** (subject to ADR-045 capability tiers) so a client built around SpecR configures its own
   onboarding fidelity and house-style deviations.

## Consequences

**Positive**

- Outputs are cleaner than inputs and **identical across formats**; DOCX↔PDF parity is guaranteed at
  every specifiable layer (styles, numbering labels, content, page setup, header/footer, table
  structure).
- PDF egress is "just another renderer" over the resolved model — as are Markdown, HTML, and `.SEC`.
- Clients control their own fidelity: defaults clean the mess, scoped rules preserve intentional
  deviation, warnings expose the unresolved, and custom-font/style opt-ins are self-service via the API.
- Every correction is auditable (`conflicts`) and reversible; the pitch becomes *"we recover the
  correct document from your messy one and emit it clean and identical across DOCX/PDF/… with a receipt
  for every correction."*

**Costs / boundaries**

- The fidelity ceiling moves from **rendering** to **extraction coverage** (the ADR-021 style program):
  the decomposition algorithm must diligently cover the enumerable style space. Every facet it doesn't
  yet capture is a **documented, closeable gap** (per the OOXML-ambiguity rule), never silent divergence.
- A residue of **non-style document mechanics** has no clean multi-format analog: live Word fields
  (a self-recomputing TOC/cross-ref/page field cannot exist in a static PDF), OLE embeds, SmartArt,
  macros. These **resolve to static values** (which a stamped artifact wants anyway) or fall outside the
  declared faithful subset.
- **Font provisioning** becomes real: a truly complete model must carry font **assets**, not just font
  names, or the PDF substitutes and diverges from a Word machine that has the font installed. Embedding
  rights are a per-font licensing check.
- The scoped-rule engine + warning surface are additional machinery to build and maintain, and the
  scoped tiers above firm/client don't all exist yet (they arrive with the style/onboarding programs).
- The irreducible DOCX↔PDF residual (exact wrap points, pagination) remains — but it is out of scope by
  the semantic-parity bar, not a defect.
