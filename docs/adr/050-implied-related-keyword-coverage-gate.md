# ADR-050: Implied Related-Section keyword coverage gate

## Status

Accepted

Refines ADR-035 (Implied Related-Section detection via title keywords). The ADR
number 049 was already claimed by `049-revit-link-inventory.md`, so this decision
takes the next free number.

## Context

ADR-035 emits an advisory `implied_related_section` finding when a spec body names
the concept of another section without citing its number. Its confidence model
awards `0.72` for a single title-keyword hit. That single-keyword rule is too
loose for multi-keyword titles built around a polysemous word.

Concrete false positive (issue #327): the catalog entry
`26 09 33 ARCHITECTURAL LIGHTING CONTROL SYSTEM` normalizes to the keywords
`architectural`, `control`, `light` (`system` is a stop word). A parking-gate spec
whose body says "Microprocessor based solid-state control board" contains only the
lone token `control` — the electrical/electronic sense, unrelated to architectural
lighting control. Under ADR-035 that single hit fired a `0.72` finding.

Confidence is not a display gate: every coordination finding surfaces
unconditionally, so lowering the score of a lone-keyword hit would be inert — the
finding would still show. Suppression has to happen at match time, not in the
score.

## Decision

Add a **coverage gate** in `matchEntry` (`src/coordination/implied-related.ts`),
after the existing empty-keywords guard:

```ts
if (matched.length < Math.min(2, entry.keywords.length)) return null;
```

The one-sentence rule: **a lone keyword fires only when it is the title's sole
discriminating keyword; otherwise at least two of the title's keywords must appear
in the paragraph.**

- Single-keyword titles (e.g. `Firestopping` → `firestop`, 1-of-1) still fire on a
  single body hit — `min(2, 1) = 1`, so `1 < 1` is false.
- Multi-keyword titles require `>= 2` matched keywords — `min(2, n>=2) = 2`, so a
  lone `control` (`1 < 2`) is suppressed while a body naming both `lighting` and
  `control` fires.
- The gate is ordered **after** the `matched[0] === undefined` guard so a fully
  suppressed, empty-keywords entry (where `min(2, 0) = 0` makes `0 < 0` false)
  still returns null and never emits an undefined keyword.

The confidence model is intentionally **left untouched** — `BASE_CONFIDENCE`,
`EXTRA_KEYWORD_CONFIDENCE`, and the cap are unchanged. There is no gating consumer
of the score to adjust; the fix belongs at the match boundary.

## Consequences

- The single polysemous-token false positive is eliminated: a body citing only one
  keyword of a multi-keyword title no longer fires.
- This is a deliberate **precision-over-recall** tradeoff, consistent with
  ADR-035's stated bias ("missing a weak implication is better than flooding a
  coordination report with generic title matches"). A body that genuinely means
  the multi-keyword section but only echoes one of its words will now be missed —
  acceptable, because that single word is by construction ambiguous.
- Single-keyword-title behavior is preserved, so existing true positives such as
  `firestop → Firestopping` continue to fire.
- Deterministic and DB-free; pinned by unit regression + positive tests in
  `src/coordination/implied-related.test.ts`.
