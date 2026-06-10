# Onboarding & Editability Program — Design

**Status:** Approved (brainstormed 2026-06-09)
**Owner decision driver:** a web onboarding flow that imports a master document (DOCX
first; SEC/TXT/PDF too), captures its visual style *and* its editor-clue conventions
(color coding, choice tokens, notes to specifier, margin comments), lets the user
review/correct the machine's first pass, and stores everything for reuse.
**Relates to:** ADR-021 (JSONB style storage), ADR-022 (editability semantics — written
with this spec), ADR-015 (library tiers), ADR-018 (lifecycle state), the
`2026-06-09-docx-style-fidelity-roundtrip-design` program (WT-1…WT-7), issues #31, #38,
#39, #41, #65, #92, #125.
**Does NOT modify:** issue #31 (stays the template-CRUD sub-MVP; it is a dependency of
this program, not its vessel) or #125 (gets its first concrete slice here, O-12, and a
cross-reference — not a rewrite).

---

## 1. Problem & vision

Firms onboard master specifications from many sources: their own company standard, a
client's template set, consultant-authored sections. These documents encode *how to edit
them* visually and conventionally:

- **Color coding** — e.g. blue text = tailor per project, black = settled boilerplate
  (common, but not gospel — conventions vary per firm/client).
- **Character coding** — `<option A><option B>` or `[option A][option B]`: the editor
  must keep one and delete the rest.
- **Note banners** — "NOTES TO SPECIFIER" blocks that are instructions to the spec
  editor, never owner-facing content.
- **Margin comments** — `comments.xml` annotations that function as specifier notes but
  are not CSI paragraphs at all.

Today the parser captures structure only; these clues are partially detected (note
banners), mostly discarded (colors, comments, tokens). The vision: an onboarding flow —
eventually a web UI — where the document loads, a first pass classifies every paragraph,
the user corrects the machine with the mouse, and the system **stores both the
classifications and the learned conventions** so the next document from the same source
classifies itself.

**Future payoff (tracked, not built now):** conformance + restyle. A client provides 50
of 70 needed sections; the consultant fills 20 from their own differently-styled masters.
Because this program reduces *everything* to semantic data — structure in the AST, visuals
in JSONB templates, editor clues as classified editability — converting the 20 to the
owner's standard is a **re-render through the owner's template** plus re-emission of
notes/choice tokens in the owner's surface syntax, not document surgery. Waves 6 (O-18,
O-19) reserve this on the roadmap.

## 2. Decisions locked during brainstorm

1. **End state of onboarding** — a *full library master*: parsed spec content lands in an
   ADR-015 library (company/client tier), plus a derived style template, plus the
   library's editor-clue convention profile. Onboarding = "bring this document into the
   platform as a reusable master."
2. **Granularity** — paragraph-level editability ships first; character-span fidelity
   (inline color spans, mid-sentence choice tokens) is a later wave dependent on WT-5
   run-span addressability. Span *offsets* are still captured from day one (cheap at
   parse time, impossible to recover later).
3. **UI strategy** — API-first (ADR-002): every onboarding capability is a REST endpoint
   driveable by curl/agents/integration tests; web UI issues come last and consume those
   endpoints (Phase 5, after #38).
4. **Convention scope** — profiles attach to a **library** (ADR-015 tier), with built-in
   industry-default rows powering the first pass when a library has no profile yet.
5. **Sequencing** — own track (`phase:onboarding` label). First implementable issues gate
   on WT-3 (import + style derivation) and #92 (libraries table). Does not disturb the
   in-flight style-fidelity worktrees.
6. **Architecture** — **persistent detection substrate** (Approach C). Import commits
   immediately; per-paragraph `source_facts` are stored permanently; classification is a
   pure function over `(facts, conventions)`, re-runnable forever without the source file.
7. **Flexibility requirement** (owner-stated): onboarding is *not* a one-shot wizard.
   Users return to **active** masters and re-tune classifications/conventions/styles
   later. Therefore the loop endpoints (correct, reclassify, convention edit, style
   assignment) operate on active masters too; the wizard is a front-end arrangement of
   ordinary endpoints, not a privileged mode.

## 3. Architecture (pipeline)

```text
1 · Upload      POST /libraries/:id/import (multipart; extends WT-3's import endpoint)
      │         targets an ADR-015 library; bytes discarded after parse (ADR-021)
      ▼
2 · Parse +     existing 5-signal inference → SpecTree
    capture     NEW: per-paragraph source_facts captured alongside (colors, choice-token
      │         candidates, comments.xml anchors, note banners, vanish) — stored PERMANENTLY
      ▼
3 · Persist +   spec lands in library with onboarding_status='review';
    derive      style template derived per WT-3 consensus (DOCX only —
      │         non-DOCX sources get style by manual pick O-12 or, later, ADR-015 inherit)
      ▼
4 · Classify ⇄ Review ⇄ Correct        classify(source_facts, conventions) → editability
      │         pure function · corrections stored as overrides · convention edits trigger
      │         POST /specs/:id/reclassify → before/after diff · NO re-upload, ever
      ▼
5 · Finalize    onboarding_status → 'active'; conventions saved to the library profile
                for the next import. Loop endpoints remain live on active masters (D7).
```

## 4. Data contracts

All JSONB payloads follow the ADR-021 philosophy: **open Zod schemas (catchall), capture
faithfully, warn — never reject or truncate.** Full rationale: ADR-022.

### 4.1 `paragraphs.source_facts` (written at parse, permanent)

```jsonc
{
  "colors":       [ { "color": "0000FF", "coverage": 0.82, "spans": [[12, 96]] } ],
  "comments":     [ { "author": "JDoe", "text": "Verify w/ owner", "anchor": [0, 34] } ],
  "choiceTokens": [ { "kind": "angle", "options": ["epoxy", "urethane"], "span": [40, 62] } ],
  "banner":       "NOTES TO SPECIFIER",
  "vanish":       true
}
```

- `colors`: distinct non-auto run colors with character coverage share and span offsets.
- `comments`: margin comments anchored to this paragraph — **facts, not tree nodes**.
  Accepting one (O-9) explicitly materializes a `note` node; no silent tree mutation.
- `choiceTokens`: conservative *candidates* (`kind: 'angle' | 'bracket'`) — the
  classification engine + conventions decide whether they mean anything.
- Format-agnostic: `.SEC`/`.txt` sources can still produce `choiceTokens` and `banner`.

### 4.2 `editing_conventions.rules` (per library; built-ins have `library_id IS NULL`)

```jsonc
{
  "colorMeanings":      [ { "color": "0000FF", "meaning": "editable" } ],
  "choiceTokens":       [ { "kind": "angle" }, { "kind": "bracket" } ],
  "noteBanners":        [ "NOTES? TO (?:THE )?SPEC(?:IFIER)?S?" ],
  "comments":           { "treatAs": "note" },
  "defaultEditability": "locked"
}
```

Built-in default seed draws from the banner regexes already in
`src/parser/docx/heuristics.ts` plus common industry conventions. A library profile
starts as a clone of a built-in and diverges.

### 4.3 Per-paragraph classification + override (two fields, never merged)

```jsonc
{
  "editability": "editable",          // locked | editable | choice | note
  "confidence":  0.92,
  "evidence":    [ { "rule": "colorMeanings[0000FF]", "fact": "colors[0]" } ],
  "override":    { "editability": "note" }    // user's word; survives every reclassify
}
```

- **Vocabulary (closed, four values):** `locked` (settled boilerplate — advisory, not
  enforced), `editable` (intended to be tailored per project), `choice` (enumerated
  pick-one/pick-some; covers whole-paragraph keep-or-delete as paragraph-grain choice),
  `note` (instructions to the spec editor; never owner-facing).
- Effective value = `override ?? classification`. Reclassify rewrites only
  `classification`; the diff report flags agreement/disagreement with standing overrides.

### 4.4 `specs.onboarding_status ∈ { review, active }`

Distinct from ADR-018 `lifecycle_state` (draft/issued/archived — issuance concerns,
Phase 5). The two coexist; ADR-022 records the separation.

### 4.5 Module placement

New `src/conventions/` module: typed `ConventionError extends SpecrError`, public
`index.ts`, knows AST types and nothing about HTTP/DB internals. The classification
engine is a pure function inside it.

## 5. Issue series (6 waves, 19 issues + umbrella)

Each issue is one sub-MVP PR: ≤500 LOC, independently CI-green, explicit test plan,
explicit out-of-scope. `Blocked by` edges below. All carry `phase:onboarding`; Wave 5
also carries `phase:5`.

**Wave 0 — program docs (this session, not issues):** this design doc + ADR-022 +
umbrella issue. Comments on #31 and #125 pointing here.

| # | Title | Blocked by |
|---|-------|-----------|
| **Wave 1 — substrate capture** (start now; parallel to WT-2/WT-3) | | |
| O-1 | `feat(parser): extract DOCX margin comments (comments.xml) as paragraph-anchored facts` | — |
| O-2 | `feat(parser): capture run color/emphasis source facts per paragraph` | — |
| O-3 | `feat(parser): detect bracket/angle choice-token candidates in paragraph text` | — |
| O-4 | `feat(db): persist paragraphs.source_facts JSONB + AST meta round-trip` | O-1, O-2, O-3 |
| **Wave 2 — conventions + classification** | | |
| O-5 | `feat(db): editing_conventions table + built-in default convention seed` | #92 |
| O-6 | `feat(conventions): editability classification engine — pure (facts, rules) → classification` | O-4, O-5 |
| O-7 | `feat(db): persist editability classification + user override per paragraph` | O-6 |
| **Wave 3 — API orchestration (headless onboarding)** | | |
| O-8 | `feat(api): library import onboarding — POST /libraries/:id/import orchestration` | WT-3, O-7 |
| O-9 | `feat(api): editability corrections + reclassify with before/after diff` | O-7 |
| O-10 | `feat(api): convention profile CRUD — built-ins, library profiles, clone` | O-5 |
| O-11 | `feat(api): onboarding finalize/reopen — onboarding_status on specs` | O-8 |
| O-12 | `feat(api): style-source assignment — manual template pick for non-DOCX masters` | #31; refs #125 |
| **Wave 4 — MCP parity** | | |
| O-13 | `feat(mcp): onboarding tools — review, correct, reclassify via MCP` | O-8…O-11 |
| **Wave 5 — web UI (Phase 5, after #38)** | | |
| O-14 | `feat(ui): onboarding wizard shell — upload, progress, report` | #38, #39, O-8 |
| O-15 | `feat(ui): review canvas — classification highlights + click-to-correct` | O-9, O-14 |
| O-16 | `feat(ui): convention editor with live reclassify preview` | O-10, O-15 |
| O-17 | `feat(ui): style picker/builder for non-DOCX masters` | O-12, #41 |
| **Wave 6 — conformance & restyle (future-phase placeholders)** | | |
| O-18 | `feat: conformance audit — flag specs deviating from project master style/conventions` | Phase 2d, WT-6, O-11 |
| O-19 | `feat: restyle to owner standard — re-render deviant specs through master template` | O-18, WT-5 |

**Relationship to in-flight work:** WT-2 (effective-style resolver) and WT-3 (template
import) proceed untouched; O-8 *extends* WT-3's endpoint surface rather than replacing
it. #31's CRUD is consumed by O-12 and the Wave 5 style builder.

## 6. Error handling

- `ConventionError extends SpecrError`; `cause` chained at every catch site that adds
  meaning (CLAUDE.md context-chain rule).
- API mapping via existing `api/middleware/error.ts`: `ConventionError` → 422; unknown
  library/spec/profile IDs → 404; malformed bodies → 400 (Zod).
- O-8 import rides the existing async-job pattern (`lib/jobs.ts`): parse/derive/classify
  failures surface in job status with the full cause chain.

## 7. Testing

- **Wave 1:** fixture DOCX files (color-coded; commented; token-bearing) → deterministic
  expected `source_facts`. Ambiguous cases (nested brackets, artifact colors) get
  `// KNOWN AMBIGUITY` tests, never silent arbitrary behavior.
- **Wave 2:** table-driven pure unit tests for the engine: `(facts, rules)` → expected
  classification + evidence. Built-in seed validated against the heuristics.ts regexes.
- **Wave 3:** integration contract tests (status codes, `ApiResponse` envelope,
  atomicity). Two decisive named tests:
  - `reclassify: convention edit reclassifies stored facts — no source document required`
  - `override survives reclassify`
- **Wave 4:** JSON-RPC `POST /mcp` integration tests per repo pattern.
- **Wave 5:** Playwright e2e, specified within those issues once Phase 5 fixes its harness.
- Regression rule applies: every bug found in classification gets a named regression test.

## 8. Out of scope (program-wide)

- Span-grain *rendering* of choice tokens / colored spans in generated DOCX (capture
  yes; rendering needs WT-5).
- Auto-learning conventions from correction patterns ("you corrected 12 paragraphs the
  same way — create a rule?") — future enhancement noted in the umbrella, not filed.
- PDF text extraction itself — #65 owns it; this series consumes whatever parsers exist.
- *Enforcement* of `locked` (advisory until auth #43 provides identity).
- Track-changes (`w:ins`/`w:del`) — Phase 3 merge territory.
- O-18/O-19 implementations — filed as placeholders; each gets its own brainstorm → spec
  cycle when its gates land.

## 9. Risks & notes

- **Storage growth:** `source_facts` adds one JSONB per paragraph permanently. Text-heavy
  but bounded; same order as the paragraph text itself. Accepted for re-classifiability.
- **Two status fields** (`onboarding_status`, ADR-018 `lifecycle_state`) risk conflation —
  mitigated by ADR-022 recording the distinction and by the closed-enum discipline.
- **Convention regexes are user data** (`noteBanners`) — treat as untrusted: compile with
  a timeout-safe approach / bounded patterns; validate at CRUD time (O-10).
- **#92 gate:** Wave 2+ depends on the libraries table. If Phase 2d slips, O-5 can ship
  with a nullable scope column and adopt the FK in a follow-up — noted in O-5's body.
- **Span offsets recorded before WT-5 exists** — they are facts, not promises; nothing
  reads them until Wave 6/WT-5. Documented in O-4 so they aren't mistaken for live data.
