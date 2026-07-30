# ADR-079: issuance-readiness gate

## Status

Accepted

## Context

\#406: a specification issued as **Final** must have every "choice" edit
resolved (bracketed `[__]` or angle-bracketed `<__>` placeholders, depending
on the firm's convention), every note-to-specifier removed, and every open
Word comment or body-level text box addressed — while a **Draft** issuance
may legitimately retain all of these. SpecR already detects every one of
these editor clues, but nothing at any issuance boundary reads them:

- `POST /specs/:id/finalize` → `finalizeOnboarding`
  (`src/db/queries/onboarding.ts:107`) is a row-locked, idempotent
  `onboarding_status review→active` flip plus a convention-profile snapshot.
  It inspects no paragraph content and is documented as advisory in two
  places (migration `033_add_onboarding_status.ts` and the function's own
  comment) — it vets whether the machine's *classification* of the document
  is trusted, a different concern from whether the document's *content* is
  ready to leave the firm as Final.
- `POST /packages/:id/revisions` (freeze a revision snapshot) and
  `POST /revisions/:id/generate` validate nothing about clue removal.
- `generate` always renders visible `note` nodes and markdown always emits
  `> **[NOTE]**` — there is no strip-notes-for-final mode.
- The detection substrate already exists end to end: choice tokens
  (`src/parser/docx/choice-tokens.ts` → `source_facts.choiceTokens`),
  specifier notes (`isSpecifierNote` / `src/lib/specifier-note-banner.ts`),
  open Word comments (`src/db/queries/open-comments.ts`), and highlighted
  runs (ADR-074's highlight-as-clue detector, `src/lib/highlight-review.ts`).

A pre-implementation spike (per this repo's design-first loop) built the
finding types, the gate function, and all four call sites — package-revision
issuance plus the three `generate` handlers — against the real code before
this design was finalized. The spike confirmed the overall shape was sound
but forced four corrections, folded into the decisions below rather than
left as a second design pass: an ESLint `max-lines` barrel-budget problem in
`db/index.ts`, a `complexity` budget problem in one new pure function, a
`max-lines-per-function` budget problem in one existing query function and
in one existing API handler, and a module-boundary gap in how a new error
class reaches an API handler. None of the four changed what the feature
*does* — only how its surface area is organized to stay inside this repo's
enforced lint budgets.

## Decision

### 1. The gate lives at package-revision issuance and all three `generate`
endpoints — never at `finalizeOnboarding`

`POST /packages/:id/revisions`, `POST /projects/:id/generate`,
`POST /packages/:id/generate` (manual multi-spec), and
`POST /revisions/:id/generate` each accept the new gate. `finalizeOnboarding`
is untouched: it answers "do we trust the machine's classification of this
document," not "is this document's content ready to leave the firm as
Final." Conflating the two would make onboarding — a one-time, per-spec
event — silently start blocking on transient content edits it was never
designed to evaluate, and would leave every already-onboarded spec with no
gate at issuance time at all.

### 2. Four finding kinds, one shared readiness evaluator, reused by report
and gate alike

`ReadinessFinding` is a discriminated union — `unresolved_choice_token`,
`specifier_note_present`, `open_comment`, `body_object_present` — each
carrying `nodeId`/`text` plus kind-specific detail (bracket vs. angle
variant, comment author, object kind). `evaluateSpecReadiness` walks a
`SpecTree` once and produces both the dry-run report (issue's proposed scope
item 1) and the enforcement gate's block list (item 2) from the *same*
walk — a report that says "clean" and a gate that still blocks would be a
worse bug than either behavior alone.

### 3. Highlighted runs are advisory-only in this gate; they never block
Final (INV-8)

The issue's proposed scope names "highlighted runs" as a candidate blocker,
but ADR-074 already treats highlight as a *editor clue*, not a structural
defect — a firm's convention may use highlight for legitimate Draft-only
annotation that has no crisp per-run "resolved" state the way a choice
token or a comment does. `evaluateSpecReadiness` calls the existing
`summarizeHighlightReview` unchanged and surfaces its report alongside the
findings (`SpecReadinessResult.highlightAdvisory`, and
`ReadinessReport.highlightAdvisory` at the stamped/aggregate level), but
`assertReadyForFinal` never reads it. A Final issuance can carry a
highlight advisory and still pass. Reimplementing highlight detection
inside this gate — rather than delegating to ADR-074's detector — was
rejected as needless duplication of an already-shipped, already-tested
concern.

### 4. `body_object_present` fires for text boxes only — never for tables
(INV-7)

ADR-072 settled that a body-level table is **structural content** — a
submittal matrix or acceptable-manufacturers grid the spec's Final content
legitimately contains — while a text box is closer to a sticky-note
annotation layered on top of the document. `bodyObjectFinding` checks
`node.meta.object?.kind === 'textBox'` specifically; a `kind: 'table'`
object node produces no finding, by design, not by omission.

### 5. `note` nodes always flag; `meta.vanish` gates everything else
(vanish-asymmetry-by-type)

`assessNode` special-cases `type === 'note'` before it ever checks
`meta.vanish`: a visible-in-Word specifier note always yields
`specifier_note_present`, matching the generator's own rendering order
(`generator/index.ts` renders `note` before it consults `meta.vanish` — a
note is only ever suppressed by being struck/deleted from the source, never
by the vanish flag alone). Every other node type short-circuits to no
findings when `meta.vanish === true`, since nothing renders it in any
output format and a hidden choice token or hidden comment cannot block an
issuance the reader will never see.

### 6. Refuse, never strip — at every gated site

The issue's open question ("does `final` generate additionally strip notes,
or refuse until they're removed?") is decided: **refuse only.** No call site
introduced by this gate ever mutates a `SpecTree` to remove notes, resolve
choice tokens, or delete comments on the caller's behalf. A blocked Final
issuance returns its findings (via the readiness-report endpoint and via the
gate's own error) so a human can fix the source and retry — SpecR does not
guess which bracketed option a specifier meant, and silently discarding a
note the user never asked to remove would be a data-loss bug wearing a
feature's clothes.

### 7. `mode` omitted is draft-equivalent, at zero evaluation cost (INV-1)

`mode?: 'draft' | 'final'` is optional on every gated request body. Omitting
it, or passing `'draft'` explicitly, is a complete no-op for
`assertReadyForFinal` — the function returns before `evaluateSpecReadiness`
ever runs, so existing callers (and every existing test) pay no new cost and
see no new behavior. Only an explicit `mode: 'final'` triggers evaluation.
This keeps the feature strictly additive for every caller that predates it.

### 8. `overrideReadinessGate` is an unaudited, unpersisted escape hatch in
this slice (INV-11) — flagged as a #380–#382 follow-up

`overrideReadinessGate: true` on a `final` request lets a caller push a
revision or generate a document through with outstanding findings. This
slice does **not** record who overrode, when, or which findings were
overridden — there is no new column, table, or audit-log entry. Reviewer
roles and sign-off tracking are explicitly out of scope for #406 (assigned
to #380–#382, ADR-052's territory), and an override flag with no accompanying
audit trail is only acceptable as a stopgap because that follow-up work
exists to close the gap properly. Shipping an ad hoc audit mechanism here
would likely be redone, not reused, once #380–#382 lands.

### 9. No new DB tables or migration — `mode`/`overrideReadinessGate` are
transient request inputs only

Both fields exist purely at the request boundary (Zod schemas) and inside
one call's control flow; neither is written to any row. A revision snapshot
issued in `final` mode is stored identically to one issued in `draft`
mode — the gate is a pre-condition on the write, not a property of the
written data. This mirrors the existing precedent of `onboarding_status`
being advisory metadata rather than a content flag, while deliberately not
extending that table: readiness is evaluated fresh from the tree at every
call, never cached or trusted stale.

### 10. The legacy create-revision body fails closed if `mode` leaks in
(INV-10)

`CreatePackageRevisionInput`'s legacy (string-body) request schema stays
`.strict()` and is left untouched; only the structured request schema grows
`mode`/`overrideReadinessGate`. A caller that mixes the two shapes — sending
`mode` on what the schema resolves as a legacy body — gets Zod's existing
422 for an unrecognized key, not a silently-ignored field. An accidental
"I asked for final and it shipped as draft" is worse than a loud rejection.

### 11. `ReadinessBlockedError` extends `DatabaseError`, matching this
codebase's existing convention

`SnapshotValidationError`, `RevisionParentValidationError`, and
`RevisionComparisonError` are all `DatabaseError` subclasses that represent
a business-rule refusal rather than an infrastructure failure — the same
shape fits a blocked Final issuance. `ReadinessBlockedError` carries
`readonly findings: readonly ReadinessFinding[]` so the error itself is the
complete picture the API layer needs to render its 422, with no second
lookup required.

### 12. `db/index.ts` gains one new sub-barrel, `index-readiness.ts`, rather
than a wholesale barrel redesign

`db/index.ts` was already at ESLint's `max-lines: 400` on `main` before this
feature. The new exports this gate needs — `getReadinessReport`,
`ReadinessScope`, `ReadinessReport`, `ReadinessBlockedError`, and the
finding/summary types, plus `assertReadyForFinal` (needed by `api/generate.ts`
per Decision 13) — do not fit inside that budget as additions. Rather than
trim or delete existing exports (risking unrelated consumers) or restructure
the barrel wholesale (out of this PR's blast radius), the fix is a
mechanical extraction: `src/db/index-readiness.ts` groups the pre-existing
open-comments re-exports (moved, names unchanged) alongside every new
readiness export, and `db/index.ts` adds a single
`export * from './index-readiness.js'` line. Every existing consumer still
imports from `'../db/index.js'` — the public import path is unchanged; only
where the re-export statements physically live has moved.

### 13. `assertReadyForFinal` is re-exported through the barrel for
`api/generate.ts`, per the sibling-barrel-only rule

The module-boundary rule (`docs/architecture/module-boundaries.md`) requires
`src/api/**` to import database-layer functions only from
`src/db/index.ts`, never from an internal file like
`src/db/queries/readiness-gate.ts` directly — exactly the discipline
`revisions.ts` already follows for its own DB imports. `assertReadyForFinal`
is therefore exported through the new `index-readiness.ts` sub-barrel like
everything else in Decision 12, not given a bespoke direct import path.

### 14. `createPackageRevision` and the three `generate` handlers needed a
genuine control-flow refactor, not a one-line gate call

Two existing functions were already at their ESLint ceiling before this
feature, so the spike's naive "add three lines at the gate point" draft
failed lint on contact with real code:

- `createPackageRevision` (`src/db/queries/revisions.ts`) gains a small,
  single-purpose `readinessInputFrom(input)` helper that extracts
  `mode`/`overrideReadinessGate` from the two accepted input shapes, called
  as one line (`const { mode, overrideReadinessGate } = readinessInputFrom(input)`)
  between the existing `snapshotMemberTrees` call and `insertSnapshotRows`.
  This is purely a budget fix — it is functionally identical to inlining
  the same three lines, just correctly decomposed to stay under
  `max-lines-per-function: 50` / `complexity: 10`.
- Each of the three `generate` handlers (`src/api/generate.ts`) has its
  existing tree/template/options resolution logic extracted into its own
  named context-loader function (`loadSingleSpecGenerationContext`,
  `loadManualGenerationContext`, `loadRevisionGenerationContext`). This
  logic already existed in each handler before this feature; extracting it
  is a refactor of pre-existing code, not new business logic, done only to
  make room for the new gate call inside the handler's own budget. A shared
  `enforceReadinessGate` helper absorbs the gate-call-plus-422-mapping
  complexity common to all three handlers, but the spike found that helper
  alone was insufficient for `generateManualHandler` (still 52/50 lines) —
  the per-handler context extraction was the actual fix. This refactor is
  scoped into the same task as the gate wiring, because the refactor exists
  only in service of that wiring; splitting it into a separate task would
  leave an interim commit with unused extracted functions.

### 15. `POST /revisions/:id/generate`'s readiness check covers changed specs
only — a documented scope limit, not a silent choice

`loadRevisionGenerationContext` resolves both `baseTrees` (the frozen
parent snapshot) and `changedTrees` (specs modified since). The readiness
gate runs against `changedTrees` only. A spec untouched since its parent
revision was already evaluated (or issued) at that prior point — re-running
the full gate against unchanged content on every subsequent generate call
would be redundant work with no new finding possible. This is recorded here
explicitly so a future reader does not mistake the narrower scope for an
oversight.

### 16. `readyForFinal` is a convenience boolean, not a second source of
truth

`ReadinessReport.readyForFinal = findings.length === 0` is computed, never
stored or passed in independently — a caller checking `readyForFinal` and a
caller counting `findings` can never disagree, and the highlight advisory
never participates in the computation (reaffirming Decision 3).

## Consequences

- A Final package revision or a Final `generate` call now refuses when
  unresolved choice tokens, visible specifier notes, open comments, or body
  text boxes remain in scope — closing the gap #406 identified: previously
  nothing gated Final issuance on content readiness at all.
- Draft issuance and every pre-existing caller (`mode` omitted) are
  unaffected — zero new evaluation cost, zero behavior change, per
  Decision 7.
- `GET /specs/:id/readiness-report` and `GET /packages/:id/readiness-report`
  give a dry-run view of the same findings the gate would enforce, so a
  specifier can resolve blockers before attempting a Final issuance instead
  of discovering them from a 422.
- No migration, no new table, no new persisted column — this feature is
  entirely request-boundary logic plus a pure evaluator over the existing
  `SpecTree`.
- `overrideReadinessGate` ships without an audit trail in this slice
  (Decision 8); recording who overrode and why is left to #380–#382 and
  should not be improvised ahead of that work landing.
- `db/index.ts` and `api/generate.ts` both grow beyond what the feature's
  apparent size would suggest — Decisions 12–14 explain why: pre-existing
  ESLint budget pressure on `main`, not scope creep in this PR.
- **Resolved** (Codex review, #544): the 422 response now carries `findings`
  inline alongside the message, not only a count and a readiness-report
  pointer — `enforceReadinessGate` (`api/readiness-guard.ts`) needed this for
  `POST /revisions/:id/generate` in particular, which gates an immutable
  revision snapshot with no readiness-report endpoint of its own; the live
  spec/package report the pointer names can read clean while the frozen
  revision it actually gated remains blocked.
- **Known limitation** (Codex review, #544; tracked at #545): "a human can
  fix the source and retry" (Decision 1) assumes a supported edit path back
  to a clean state. For three of the four finding kinds — unresolved choice
  token, specifier note, open comment — no such path exists today:
  `source_facts` (choice tokens, comment-closed state) is a parse-time
  snapshot no write path refreshes, and `note`/text-box `object` nodes have
  no delete/resolve operation (`REMOVABLE_NODE_TYPES` excludes both). Today
  `overrideReadinessGate: true` is the only way past these three kinds on
  content already in the database — a real but blunt bypass, not the
  resolution path the "block, never strip" framing implies. `#545` scopes
  the fix; not addressed in this PR.
