# Design: Hidden-text filtering + asterisk note-delimiters

- **Date:** 2026-06-25
- **Status:** Approved (brainstorm) — pending implementation plan
- **Related ADR:** ADR-038 (to be written with PR 1)
- **Motivating artifact:** `docs/references/MANUFACTURER_EXAMPLES/hidden-text-test.docx` (gitignored; a UFGS/SpecsIntact-style master spec, section `01 88 15 — SEISMIC ANCHORAGE AND BRACING`)

## Problem

A firm's master-spec DOCX broke in the `examples/web_ui_demo` parse view. Running the real
`/parse` orchestrator path on the artifact reproduced two user-visible failures plus two latent
data-loss bugs:

1. **Asterisk note-delimiters are not understood.** The firm brackets every editor note with a row
   of ~83 `*`. The parser retains **14 walls of asterisks as literal note text**. Notes are caught
   here *only incidentally* — this firm's note paragraph style is named `STNoteSpec`, which matches
   the existing `/note/i` style-name heuristic (`inference.ts isNoteParagraph`). A firm whose note
   style were named e.g. `STInfo`, or who used bare hidden text, would have **every note paragraph
   pollute the CSI hierarchy**. There is no content-based asterisk-block detection anywhere (DOCX or
   text/PDF).

2. **Hidden content clutters the hierarchy root.** Root nodes come out as
   `continuation, continuation, note×5, part, part, part` — the hidden "SPECIFICATION PROCESSING
   FORM" + sign-off/revision block lands as 5 `note` nodes *ahead of PART 1*, tripping the
   `root-continuation` warning. Hidden text is turned into in-tree `note` nodes rather than being
   held out of structural inference.

3. **Hidden detection is fragile (latent).** `document.ts resolveIsVanish` only checks the
   paragraph-mark `w:pPr/w:rPr/w:vanish`. It misses run-level vanish, paragraph-style vanish, and
   character-style vanish. (In this artifact the note *prose* is genuinely visible — `STNoteSpec`
   has no style-level vanish — while only the asterisk rule rows and the top processing-form block
   are hidden. Other firms hide the prose via the style, which today goes undetected.)

4. **Tables are not parsed at all (latent).** `parseDocument` reads only top-level `body['w:p']`, so
   all 4 tables are dropped — the 3 **hidden** sign-off/revision tables (the change-management data
   to retain) *and* the 1 **visible** submittal-schedule table (real content, silently lost).

### What already works (do not re-touch)
- Section/title recovery: the orchestrator's `inferSectionMeta` recovers `01 88 15 — SEISMIC
  ANCHORAGE AND BRACING` from content; this is **not** broken.
- `SourceFacts` (per-paragraph comments/colors/choice-tokens) is the onboarding "editor-clue"
  substrate and already declares unused `banner?` and `vanish?` fields.
- `StyleInfo.isVanish` is already parsed per paragraph style (`styles.ts:87`) — just never consulted
  for paragraph hidden-detection.

## Goals

1. Robustly detect hidden/invisible OOXML content (text **and** tables) and **exclude it from the
   5-signal CSI inference** — clean hierarchy, no hidden junk at root.
2. **Retain** hidden content losslessly (round-trippable text in-tree; hidden tables in a flat
   sidecar) — never destroyed; ready for the future change-management/document-control feature.
3. Detect the **asterisk-row note-delimiter** convention by content, in a **shared** path so DOCX
   *and* text/PDF both benefit.
4. **Surface** both signals on the onboarding substrate (`source_facts`) so the firm-template
   pipeline can see them.

## Non-goals (deferred, with seams)

- Typed revision-history / sign-off table schema (`{rev, date, author, description}`) — future
  change-management feature. This sprint retains hidden tables as a flat grid only.
- Modeling **visible** table content into the spec tree — this sprint detects and **warns** only.
- Persisting retained hidden tables to the DB.
- Learning the detected conventions into a firm's editing-convention profile (ADR-022). This sprint
  **records facts only**.

## Design decisions (locked during brainstorm)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Hidden tables: **parse + retain flat** (rows of cell text), out-of-band, no typed schema. | Lossless retention behind a clean seam; the grid survives for the future change-mgmt feature without committing to a speculative schema now. |
| D2 | Visible tables: **detect → warn only**, do not inject text into the tree. | Avoids guessing table semantics; ends the silent data loss. |
| D3 | Asterisk note block: **strip the rule rows, classify each enclosed paragraph as its own `note` node**, record a convention `source_fact`. | Preserves per-paragraph UUID anchors for round-trip/merge; mirrors the SEC NTS path; excludes the block from CSI inference. |
| D4 | Onboarding: **record facts only** (`source_facts.vanish` + a note-delimiter fact; flat hidden-table retention). | The substrate `derive-template`/editing-conventions already consumes; learning into a firm profile is a follow-up. |
| D5 | Hidden text **stays in the tree** as `vanish` `note` nodes, excluded from the 5-signal structural pass — **not** pulled into a sidecar. | Pulling it out would break SpecR's UUID round-trip/merge contract. Hidden *tables* go to the sidecar because they have no anchors today anyway. |

## Architecture

Changes are confined to the parser and one shared lib helper. No DB schema change this sprint.

```
src/lib/note-delimiters.ts        NEW — pure: isRuleRow() + note-block segmentation (shared)
src/parser/docx/styles.ts         resolveVanishChain + vanishStyleIds/vanishCharStyleIds on StyleMap
src/parser/docx/types.ts          StyleMap gains the vanish sets; ClassifiedParagraph unchanged
src/parser/docx/document.ts       robust resolveParagraphVanish (run/para-mark/style); table scan
src/parser/docx/inference.ts      skip hidden in 5-signal pass; asterisk pre-pass; audit ignores hidden
src/parser/docx/source-facts.ts   populate SourceFacts.vanish + note-delimiter fact
src/parser/docx/index.ts          surface SpecTree.hiddenTables; thread style vanish sets
src/parser/text/signals.ts        wire shared note-delimiter detection (text/PDF path)
src/ast/types.ts / schemas.ts     SpecTree.hiddenTables?; new ParseWarning 'table-content-skipped'
openapi.yaml                      tree.hiddenTables + warning enum (contract gate)
```

### Component 1 — Robust vanish resolution `(docx)`
Replace `resolveIsVanish` with `resolveParagraphVanish`, returning hidden when **any** holds:
- paragraph-mark `w:pPr/w:rPr/w:vanish`; **or**
- the paragraph `pStyle` resolves to vanish through the `basedOn` chain; **or**
- the paragraph has text-bearing runs and **every** one is vanish (direct `w:r/w:rPr/w:vanish`, or a
  vanish character `rStyle`).

`StyleInfo.isVanish` already exists. Add `resolveVanishChain` (mirroring `resolveNumPrChain`) and
expose `vanishStyleIds` (paragraph styles) + `vanishCharStyleIds` (character styles — `parseStyleInfo`
currently drops non-paragraph styles; add a minimal vanish-only capture) on `StyleMap`. Thread these
into `parseDocument`. Each genuinely-ambiguous case gets a `// KNOWN AMBIGUITY:` test per CLAUDE.md.

### Component 2 — Exclude hidden from inference + retain + fix audit `(docx)`
Hidden paragraphs remain in the tree as `vanish` `note` nodes (round-trip/merge anchors preserved,
suppressed in render) but are **skipped by the 5-signal structural pass** — they never become
hierarchy parents and never set `prevNonContIlvl`. `auditTreeStructure` stops counting hidden nodes
as `root-continuation` junk, so the demo root becomes a clean `part, part, part`.

### Component 3 — Shared asterisk note-delimiter detection `(lib + docx + text)`
`src/lib/note-delimiters.ts` (pure):
- `isRuleRow(text)` — trimmed text consists only of `*` and is at least `RULE_ROW_MIN` long
  (threshold chosen to skip `**bold**`/`***` emphasis; artifact rows are 10–83). Structured so other
  rule chars could be added later, but **asterisks only** this sprint (YAGNI).
- block segmentation over an abstract line/paragraph stream: a rule row opens a note region;
  enclosed paragraphs are notes; the next rule row closes it. **Safety break:** a structural heading
  (PART/Article) closes an open region, so an unbalanced row cannot swallow the section.

Wiring:
- **DOCX** — a pre-pass in `classifyParagraphs` annotates rule rows (suppressed) and enclosed
  paragraphs (→ `note`, excluded from inference), independent of the `/note/`-style-name path.
  Records a `noteDelimiter` `source_fact`.
- **Text/PDF** — the same module feeds `text/signals.ts` so asterisk notes stop becoming
  `continuation`.

### Component 4 — Tables: classify, retain hidden, warn visible `(docx)`
Scan `body['w:tbl']` separately (order-independent — no `preserveOrder` change needed). Per table:
extract cell text; classify hidden (all cell runs vanish) vs visible.
- **Hidden** → push to a flat `SpecTree.hiddenTables` sidecar (`{ rows: string[][] }`; grid
  preserved, lossless, **not persisted** this sprint).
- **Visible** → emit a new `ParseWarning` `'table-content-skipped'` (ends the silent loss of the
  submittal table).

Table-nested paragraphs already live under `w:tbl`, not `body['w:p']`, so they never enter the
hierarchy — exactly the desired exclusion.

### Component 5 — Onboarding surface `(source-facts)`
Populate the already-declared `SourceFacts.vanish` and add a note-delimiter fact per paragraph in
`source-facts.ts` (it already walks runs for color — natural home for run-level vanish coverage).
This is the substrate `derive-template`/editing-conventions consumes; no learning step this sprint.

## Data flow

```
parseDocx(buffer)
  buildStyleMap  → StyleMap { …, vanishStyleIds, vanishCharStyleIds }
  parseDocument  → DocxParagraph[]  (resolveParagraphVanish per paragraph)
                 → scan w:tbl → hiddenTables[] + table-content-skipped warnings
  parseParagraphSources → SourceFacts { …, vanish?, noteDelimiter? }
  classifyParagraphs
     pre-pass: note-delimiter segmentation (strip rule rows, mark enclosed → note)
     5-signal pass: SKIP hidden + note paragraphs (structural inference on visible content only)
  buildTree → SpecTree { parts, hiddenTables?, warnings? }
  auditTreeStructure → ignores hidden nodes
```

## Error handling
Boundary errors stay typed (`ParserError`, `cause`-chained) per CLAUDE.md. The note-delimiter lib is
pure and total (no throws); malformed/unbalanced rule rows degrade via the structural safety break,
not exceptions. Table scan tolerates missing `w:tbl`/empty cells (returns no tables / empty rows).

## Contract notes
- `SpecTree.hiddenTables?` and the new `'table-content-skipped'` warning type **must** update
  `openapi.yaml` in the same PR (the contract gate enforces route↔spec↔response coverage).
- Module boundaries: shared logic in `src/lib/`; parsers import only via sibling barrels.

## Testing

- **Unit (CI-safe, inline OOXML fragments):**
  - vanish resolver — run-level, paragraph-mark, paragraph-style (basedOn chain), character-style;
    `// KNOWN AMBIGUITY:` for mixed visible/hidden runs.
  - `isRuleRow` + block segmentation — balanced, unbalanced (safety break), lone opener,
    `**bold**` non-match.
  - table classification — all-vanish → hidden; mixed → visible.
- **Integration (gated on `existsSync` of the gitignored artifact, like the ARCAT tests):** asserts
  clean 3-part root, **0** asterisk-wall nodes retained as text, hidden processing-form excluded from
  structure, `hiddenTables.length ≥ 3`, a `table-content-skipped` warning present. Runs locally,
  skips in CI.
- Regression-test names state the symptom, e.g.
  `'asterisk notes: rule-row delimiters stripped, enclosed prose → note (not continuation)'`.

## PR decomposition (each ≤ ~500 LOC; `main` green between)
1. **Robust vanish + exclude-from-inference + audit fix** (Components 1–2) — and ADR-038.
2. **Shared `note-delimiters` lib + DOCX wiring** (Component 3, DOCX half + `source_fact`).
3. **Table parse / classify / retain / warn + `openapi.yaml`** (Component 4).
4. **Text/PDF note-delimiter wiring + `source_facts.vanish` population** (Components 3-text + 5).

Each PR files/links a GitHub issue, opens as a **draft**, and moves through the Project board
(`Ready → In progress → In review → Done`).
