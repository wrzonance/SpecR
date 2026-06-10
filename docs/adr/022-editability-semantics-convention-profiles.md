# ADR-022: Editability semantics, convention profiles, and persistent source facts

## Status: Accepted

Builds on ADR-021 (extensible JSONB style storage), ADR-015 (library tiers), ADR-003
(canonical CSI AST). Companion spec: `2026-06-09-onboarding-editability-design.md`.

## Context

Master specification documents encode *how they are meant to be edited* through visual
and textual conventions: color-coded text (blue = tailor per project), enumerated choice
tokens (`<option A><option B>`, `[keep this][or this]`), "NOTES TO SPECIFIER" banners,
and margin comments that are editor instructions rather than spec content. These
conventions vary by firm and client — color meanings especially are common practice, not
gospel.

Today the parser detects note banners and `w:vanish` but discards run colors, never reads
`comments.xml`, and treats choice tokens as plain text. ADR-021 mandates discarding the
source DOCX bytes after import, so anything not captured at parse time is gone: a later
change to "what blue means" could only be honored by re-uploading the document.

The onboarding program needs: (a) a machine-readable editability model; (b) per-source
convention storage so the system learns each library's dialect; (c) the ability to
re-classify a document **long after import** — the owner explicitly requires returning to
active masters and re-tuning them, and the future conformance/restyle capability
(consultant specs converted to an owner's standard) depends on the same data.

## Decision

### D1 — Closed editability vocabulary, paragraph grain first

Each paragraph carries an effective editability from a **closed four-value enum**:

- `locked` — settled boilerplate; advisory (no enforcement until auth #43 exists).
- `editable` — intended to be tailored per project.
- `choice` — enumerated pick-one/pick-some. Whole-paragraph keep-or-delete is modelled
  as paragraph-grain `choice`, not a fifth value — the enum stays closed and small (the
  ADR-014/ADR-018 lesson: process specifics never become new states).
- `note` — instructions to the spec editor; never owner-facing output (aligns with the
  existing `note` NodeType handling).

Character-span editability (inline colored phrases, mid-sentence tokens) arrives later
with WT-5 run-span addressability; the vocabulary is unchanged by that extension.

### D2 — Classification and user override are separate fields

`classification` (machine, with `confidence` + `evidence`) and `override` (human) are
stored side by side and never merged. Effective value = `override ?? classification`.
Re-classification rewrites only `classification`; standing overrides survive and
disagreements are surfaced, not absorbed. The machine never silently undoes a human.

### D3 — Convention profiles are library-scoped data, with built-in defaults

A new `editing_conventions` table holds JSONB rulesets (color meanings, active
choice-token grammars, note-banner regexes, comment policy, default editability).
Profiles attach to an ADR-015 **library** ("this client writes blue-means-editable
masters"); rows with `library_id IS NULL` are built-in industry defaults that power
first-pass classification when no profile exists. A library profile typically starts as
a clone of a built-in and diverges. Conventions are **data, not code** — the same
classifier serves every firm.

### D4 — Source facts are captured at parse and persisted permanently

A `paragraphs.source_facts` JSONB column stores what the source document actually
contained per paragraph: distinct run colors with coverage and span offsets, margin
comments (`comments.xml`) with anchors, choice-token candidates with offsets, banner
matches, vanish. Facts are captured **once**, at the only moment the bytes exist
(ADR-021 discards them), and kept forever.

Classification is then a **pure function** `(source_facts, convention_rules) →
editability` — re-runnable at any time, with no source document, years after import.
Span offsets are recorded from day one even though nothing renders them until WT-5:
cheap now, unrecoverable later.

Margin comments are facts, **not** tree nodes. Accepting one as a specifier note
explicitly materializes a `note` node in the AST; the tree is never mutated silently.

### D5 — Validation follows ADR-021: open schemas, capture-never-reject

`source_facts` and convention `rules` use open Zod schemas (known keys typed, unknowns
preserved via catchall). A document's odd color or an unanticipated fact shape is
captured and warned about, never truncated or refused. One exception class: convention
`noteBanners` regexes are **user-supplied executable patterns** — they are validated and
bounded at CRUD time (untrusted input), unlike captured facts.

### D6 — `onboarding_status` is distinct from `lifecycle_state`

`specs.onboarding_status ∈ { review, active }` records whether a human has reviewed the
machine's first-pass classification. ADR-018's `lifecycle_state` (draft/issued/archived)
records issuance posture. They answer different questions and coexist; neither absorbs
the other. Crucially, `active` does **not** seal the spec: classification, reclassify,
convention, and style endpoints keep working on active masters — onboarding is ordinary
endpoints arranged as a flow, not a privileged one-shot mode.

## Consequences

**Positive**

- Re-classifiability forever: convention changes re-apply to stored facts; no re-upload.
- The system learns each client's dialect; the next import from the same library
  classifies itself.
- Foundation for conformance audit + restyle-to-standard (mixed-source projects): since
  structure, style, and editability are all semantic data, converting a deviant spec to
  the owner's standard is a re-render, not document surgery.
- The substrate (run-grain facts with offsets) is exactly what Layers 2/3 of the
  style-fidelity program (WT-4/5/7) need — captured once, shared.

**Negative / trade-offs**

- Permanent storage growth: one `source_facts` JSONB per paragraph, same order of
  magnitude as the paragraph text. Accepted.
- Two status fields on `specs` invite conflation — mitigated by this ADR and closed enums.
- Facts captured before any consumer exists (span offsets) must be documented as inert
  until WT-5, or they will be mistaken for live behavior.
- Editability is advisory metadata until authentication exists; `locked` does not
  prevent writes.

**Neutral**

- The existing banner heuristics (`parser/docx/heuristics.ts`) become the seed content
  of the built-in default profile; detection moves from hardcoded to data-driven without
  behavior change for existing parses.
