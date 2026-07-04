# Design: PDF Artifact Egress (#352)

**Status:** Draft for review. Companion to **ADR-048** (model-driven multi-format egress — the
governing framing) and the eventual rendering-approach ADR. Ships alongside ADR-048 in PR #357.
**Date:** 2026-07-03 (updated with the TOC-register + ingested-template refinements).
**Issue:** #352 — render specs to PDF sharing the DOCX style + CSI numbering source-of-truth.
**Session goal:** decide the rendering approach + tradeoffs, and scope the first slice. NOT implementation.

## Governing framing (see ADR-048)

This design sits **inside** ADR-048. The load-bearing decisions there:

- **Normalize, don't photocopy.** SpecR renders fidelity-**to-intent**, not to the messy input DOCX.
  Hardcoded numbers are regenerated; direct-format overrides map to canonical style-per-node-type;
  content is preserved. The input is the *worst* parity reference.
- **All formats render from one resolved model.** DOCX, PDF, Markdown, HTML, `.SEC` are peer consumers;
  no renderer sees raw OOXML. **Passthrough is rejected** — because the OOXML style space is *enumerable*,
  a complete decomposition is lossless, so model-driven DOCX loses no fidelity that matters and
  passthrough only adds drift.
- **Parity is model↔renderers, not output↔input.** The pixel-diff harness (#150) compares
  SpecR-DOCX vs SpecR-PDF (both from the model).
- **Corrections are audited** via `paragraphs.conflicts`; normalization is governed by **client-scoped
  levers** (defaults strip junk; scoped rules preserve intentional emphasis; unresolved styles warn;
  custom fonts/styles are opt-in and API-exposed).

PDF egress is simply the newest renderer over that model.

## Parity bar

**One source of truth (semantic).** Both outputs consume the same resolved model, so a template/numbering
change moves both identically. We do NOT attempt to match what Microsoft Word *renders* a DOCX as,
pixel-for-pixel — the residual (line-breaking, hyphenation, pagination) is an engine difference no model
fixes, and it is out of scope by this bar. Everything *specifiable* (styles, numbering labels, content,
page setup, header/footer, table structure) matches.

## Architecture — the shared resolution seam

Today `generateDocx(tree, styleRules?, options?)` resolves `styleRules → StyleProperties` per `NodeType`
(`buildRuleMap`) and maps straight into **docx-library-specific** options
(`runStyleOptions`/`paragraphStyleOptions`). That translation is the thing to factor out.

```
Ingested DOCX (onboarding)                 SpecTree + styleRules + numbering (+ headerFooter, later)
   │  decompose (never fed to a renderer)          │
   ▼                                               ▼
Resolved Style Template (ADR-021 JSONB) ─────►  resolveRenderModel()  ──►  ResolvedBlock[] / TocModel
                                                   │   { nodeType, level, computedLabel, text,
                                                   │     style:{font,size,bold,italic,spacingBefore,
                                                   │            spacingAfter,indentLeft,hanging,align},
                                                   │     uuid }
                                                   ├──► docx renderer  (peer consumer; ResolvedBlock → w:p / w:tbl)
                                                   ├──► pdf  renderer  (NEW; ResolvedBlock → pdfmake content)
                                                   └──► markdown / html / .SEC
```

- **The ingested DOCX is decomposed, never rendered-through.** The PDF engine understands no OOXML;
  onboarding extracts style into the resolved template (ADR-021), and *that* feeds every renderer.
- **Numbering stays consistent by construction.** PDF computes label strings via the same `getLabel`
  (`src/generator/markdown.ts`) the markdown renderer uses; DOCX keeps Word's numbering engine but is fed
  the identical config (`buildSpecNumberingConfig`), so labels match. (Reuse `getLabel` — CLAUDE.md gotcha.)
- **Blast-radius control.** Introduce `resolveRenderModel` as a new shared unit; the PDF renderer consumes
  it now. Migrating the *existing* DOCX path onto it is a low-risk mechanical fast-follow (numbering config
  already shared; only style resolution + label computation move) — kept out of the first PR.

## Rendering-mechanism decision (the dependency choice)

Evaluated against: headless Node 22 API, MIT/Apache-preferred, **deterministic-first** brand, must
natively do running headers/footers + "Page X of Y" + computed multilevel numbering. (Cross-validated
research with sources archived in the session; summary below.)

| Option | Verdict |
|---|---|
| **pdfmake** (MIT, pure Node) | **CHOSEN.** Deterministic out-of-the-box (`info.creationDate` explicit; no post-process pass). Native `footer(currentPage,pageCount)`, auto page breaks, custom fonts (vfs), margins, indents, and a native `table` primitive (see TOC-register below). Our render is a *flat* sequence of labeled, indented paragraphs, which suits its content-array model. CVE-2025-11362 / CVE-2026-26801 are **remote-URL-embedding only** — a path we never use; pin ≥0.3.6, leave `setUrlAccessPolicy` closed. |
| **@react-pdf/renderer** (MIT) | Strong alternative; component model maps to the recursive tree, best-maintained, easiest for *rich* layouts. Rejected as primary: **not byte-stable by default** (bakes `/CreationDate` + `/ID`), needs a metadata-normalization post-step + React dep. The one place it wins is a **colored comparison-matrix PDF** (#351 output) with conditional per-cell styling — flagged as the future case to revisit. |
| **Chromium (Playwright/Puppeteer)** | **Rejected.** "Already in-repo" is false (Playwright is the agent's MCP tool, not a project dep). Hundreds-of-MB **runtime** Chromium dep, worst determinism (baked timestamps/IDs; shifts across versions), clumsy "Page X of Y." |
| **pdfkit** (MIT) | Fallback — the substrate under pdfmake. Hand-build H/F repetition + page counting. |
| **Typst** (Apache-2.0) | Best reproducibility but a Rust binary + own markup — runtime/toolchain mismatch. |
| **WeasyPrint** (BSD) | Python + native libs — runtime mismatch. Out. |

### Determinism note (first-class for SpecR)

pdfmake bakes a `/CreationDate` unless set. Pin it explicitly via the document `info` (a fixed value
derived from the spec/revision, not wall-clock) so identical inputs → byte-stable PDF. Mirrors the
byte-stability just enforced for the #351 compare report.

## Companion: the stamped TOC / package register

A spec-package "table of contents" the AoR/EoR stamps is **not** a navigational Word TOC field — it is a
**data register**: a table with columns *section number · name · package · issuance date*, grouped by CSI
division. Two different artifacts often both called "TOC":

| | Navigational TOC (Word field) | Package register (this) |
|---|---|---|
| Source | Word scans headings | **DB query on the package** |
| Computed by | Word, at open-time | **SpecR, at generation** |
| Deterministic / stampable / reproducible-in-PDF | No | **Yes** |

A field TOC recalculates on open → legally unsafe for a sealed doc and impossible to reproduce in PDF.
The register is a static, DB-driven table, so it renders **identically** in DOCX and PDF from one model.

Design consequences:

- **New shared primitive** `TocRegisterModel` (`divisions[] → rows[]{number,name,package,issuanceDate}`),
  a peer of `ResolvedBlock` on the `resolveRenderModel` seam. DOCX renders it as an OOXML `w:tbl`
  (dolanmiu/docx `Table`), **not a field**; PDF renders it as a pdfmake `table`.
- **Explicit, data-driven division breaks.** Word and the PDF engine paginate differently, so encode
  "break between divisions" as a directive (`pageBreakBefore` per division / keep-together) rather than
  relying on natural flow — both engines then break in the same predictable places.
- **Frozen at issuance.** The sealed register reads the **package-revision snapshot** (as-issued manifest),
  not live DB, so a re-generated stamped artifact is immutable.
- **Reinforces pdfmake:** a columnar register grouped by division with explicit breaks is pdfmake's native
  wheelhouse (`table` + `pageBreak` + `dontBreakRows`), and determinism matters more for a sealed artifact.
- **Visual seal image** is trivial box/image placement in both renderers; **cryptographic PDF signing**
  (PAdES) stays a non-goal.

## Fidelity & the ingested template (see ADR-048)

Because the OOXML style space is **enumerable**, a diligent decomposition renders DOCX at passthrough
fidelity *and* PDF at parity — "near-perfect match" at every specifiable layer. The ceiling is not
rendering; it is:

1. **Extractor coverage** (the ADR-021 style program) — every uncaptured facet is a *documented, closeable*
   gap (OOXML-ambiguity rule), never silent divergence.
2. **Font provisioning** — the model must carry font **assets**, not just names, or PDF substitutes and
   diverges from a Word machine that has the font; embedding rights are a per-font check.
3. **Non-style document mechanics** — live Word fields, OLE, SmartArt have no clean PDF analog; they
   resolve-to-static (which a stamped artifact wants) or fall outside the faithful subset.

Normalization levers (ADR-048) apply during style import: defaults strip junk (stray highlight/underline/
bold), scoped rules preserve *intentional* emphasis, unresolved styles **warn**, and custom fonts/styles are
**opt-in and API-exposed**.

## Scope — first slice

- **`renderSpecPdf(tree, styleRules?, options?)`** in the generator layer, mirroring `generateDocx`:
  single-section spec → PDF. Style + numbering parity with the DOCX output.
- **Page furniture:** margins/page size (Letter) + a page-number footer ("Page X of Y"). Full running
  header/footer from `HeaderFooterComposition` deferred (below).
- **REST:** a binary-artifact egress endpoint mirroring `POST /specs/:id/generate` (DOCX). Update
  `openapi.yaml` in the same PR (contract gate).
- **MCP (ADR-044):** mirror the DOCX generate op — most likely an `MCP_UNEXPOSED` artifact-egress exemption
  (binary bytes are a poor MCP payload), reasoned in `contract-map.ts`; keep the contract gate green.
- **Tests:** determinism regression (byte-identical PDF after metadata pinning) + render against ARCAT and
  CPI fixtures (CPI ilvl offset — CLAUDE.md gotcha).

## Explicit non-goals / follow-ups

- **TOC / package register renderer** — designed above as a companion; its own slice (needs the shared
  `TocRegisterModel`, the frozen package-revision manifest, and DOCX-table + PDF-table renderers).
- **Running header/footer from `HeaderFooterComposition`** — resolution exists (`db/queries/header-footer.ts`)
  but neither `generateDocx` nor `generateManual` consumes it yet (no running H/F today). A follow-up wires
  *both* renderers at once (PDF may lead — pdfmake makes H/F trivial).
- **Migrating the existing DOCX renderer onto `resolveRenderModel`** (mechanical fast-follow).
- **Font-asset provisioning** for custom client fonts (embed-on-ingest / font library / substitution map).
- Batch/issued-set PDF; pixel-diff parity harness (#150); PDF cache (#52).
- PDF *ingest*/extraction (ADR-034 / #65) — unrelated. Interactive/AcroForm PDFs, digital signatures.

## Acceptance (for the eventual implementation)

- Same spec → DOCX and PDF apply the same resolved styles + numbering labels; a style-template or
  numbering-profile change shifts both identically.
- Same input → byte-identical PDF every run (metadata pinned).
- `renderSpecPdf` consumes the shared `resolveRenderModel`, not a re-derived style/numbering path.
- New REST op documented in `openapi.yaml`; MCP contract gate green (tool or reasoned exemption).
- Rendering-approach ADR recorded; pdfmake license (MIT) + CVE posture noted.
- Tested against ARCAT + CPI fixtures.

## Open questions for the user

1. **Library:** recorded choice **pdfmake** (deterministic-native, table-strong for the register). Revisit
   @react-pdf/renderer only if the colored comparison-matrix PDF becomes a near-term deliverable. Confirm.
2. **TOC-register:** confirm it's a defined companion slice (after the section-body PDF), reading the frozen
   package-revision manifest.
3. **Header/footer scope:** confirm running H/F is a follow-up (first slice = style + numbering + page-number
   footer), given DOCX doesn't emit running H/F yet.
4. **MCP surfacing:** `MCP_UNEXPOSED` artifact-egress exemption (mirror DOCX generate) vs a `render_pdf` tool.
