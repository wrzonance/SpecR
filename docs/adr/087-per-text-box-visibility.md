# ADR-087: per-text-box hidden/visible decision, not first-entry-wins

## Status

Accepted

## Context

ADR-038 established the general rule for hidden OOXML content: retain it,
exclude it from inference, never discard it silently. ADR-072 addendum 20
separately flagged that `body-objects.ts`'s anchor walk operates on the
`preserveOrder`-mode blob tree (`ObjectBlobNode`) while everything upstream
of it — `classifyParagraphDrawings`, `isHiddenTextBox`, `isTextBoxEntry` —
operates on the grouped-mode `raw` tree the rest of `document.ts` already
parses. Those two trees are independently parsed and share no node
identity.

`collectParagraphDrawing` (`body-objects.ts`) previously called
`entries.find(isTextBoxEntry)` — the FIRST text-box `DrawingRunEntry` in the
host paragraph, full stop — and asked `isHiddenTextBox` about that one entry
only. A host paragraph with two or more separate text boxes (a hidden
document-control box followed by a visible content box, or vice versa) got
one hidden/visible verdict applied to the whole paragraph:

- If the first box happened to be hidden, `isHiddenTextBox` returned `true`
  and the paragraph's object was dropped (or its interior text suppressed)
  wholesale — silently discarding a SECOND, visible box's real content,
  violating ADR-038's retention rule.
- If the first box happened to be visible, the paragraph's object was built
  normally with no suppression at all — leaking a second, hidden box's
  interior text into `interiorTexts`, violating the opposite half of the
  same rule (ADR-038's requirement that hidden content stay excluded from
  visible output).

Either direction is a real bug for a firm master that puts a hidden
revision-history box and a visible content box in the same host paragraph
(a shape UFGS/CPI-style document-control layouts produce). Fixing it
requires two things ADR-072's original design didn't need: (1) a
hidden/visible verdict computed per text box, not once for the paragraph,
and (2) a way to tell the `preserveOrder`-side anchor walk which specific
`w:txbxContent` blob nodes correspond to the hidden boxes — the walk has no
independent hidden-detection signal of its own; hidden-ness is only ever
knowable from the grouped-mode `raw` tree.

## Decision

**1. Evaluate every text-box entry, not just the first.**
`collectParagraphDrawing` now does `entries.filter(isTextBoxEntry)` instead
of `.find`, and maps the existing `isHiddenTextBox(raw, entry.run,
styleMap)` primitive over every entry to produce `hiddenFlags: readonly
boolean[]` — one flag per text box, in the same document order
`classifyParagraphDrawings`/`runsOf(raw)` already walk. No new
hidden-detection logic; the same per-entry check that previously ran once
now runs once per box.

**2. Correlate the two trees by document order, not by node identity.**
A new sibling module, `src/parser/docx/body-text-box-visibility.ts`, exports
`resolveHiddenTxbxContentNodes(hostNode, hiddenFlags)`. Given a host
paragraph's already-AC-normalized blob root, it depth-first-collects every
`w:txbxContent`-tagged descendant of the root's OWN children (left to
right — the same order the grouped-mode walk produces), pairs boundary `i`
with `hiddenFlags[i]`, and returns a `ReadonlySet<ObjectBlobNode>` of the
`w:txbxContent` node references that are hidden. This is a positional
correlation, not a content or attribute match: the two trees have no shared
id to join on, so array-index alignment over a walk order both sides
already produce independently is the only mechanism available. The module
is self-contained (own `tagOf`/`childrenOf`/`isBlobNodeArray`), mirroring
the established per-module helper duplication already used by
`body-order.ts` and `body-objects.ts`, rather than reaching into
`body-objects.ts`'s internals across the module boundary.

**Fail-closed on correlation-count mismatch.** If the number of
`w:txbxContent` boundaries found under the host node does not equal
`hiddenFlags.length`, every boundary found is treated as hidden — the
positional correlation is only trustworthy when the counts agree, and a
mismatch means something upstream (a text box shape neither side's walk
expected) broke the assumption. Over-suppressing an object's interior text
is the safe failure direction per ADR-038's posture: never leak hidden
content, even when the mechanism that would normally decide what's hidden
can't confirm its own answer. This path was spiked against every fixture
shape available (two plain DrawingML boxes, visible+hidden, a
`w:hyperlink`-wrapped box, and an `mc:AlternateContent`-wrapped box mixed
with a plain one) and never triggered — it is a defensive backstop, not a
path exercised by any known document shape.

**3. `w:txbxContent`-node targeting, not `w:r`.** The boundary
`resolveHiddenTxbxContentNodes` locates and hides is the `w:txbxContent`
node itself, not its containing `w:r`. This matters for a text-box run
wrapped in `w:hyperlink`: `runsOf(raw)` (grouped-mode) already reaches
inside `w:hyperlink` to find the run, and the blob-side walk needs no
parent-shape knowledge at all because it matches by node identity/tag, not
by "is this a direct child of `w:p`". Targeting `w:r` instead would have
required teaching the blob-side walk about every wrapper shape the
grouped-mode side already tolerates.

**4. `transformChildren` treats a hidden `w:txbxContent` node as opaque.**
`anchorInteriorParagraphs`/`transformInteriorParagraphs`/`transformChildren`
(`body-objects.ts`) now thread a `hiddenSubtrees: ReadonlySet<ObjectBlobNode>`
parameter end to end. `transformChildren` checks `hiddenSubtrees.has(child)`
before its existing `tag === 'w:p'` branch: a hidden child is pushed into
`newChildren` unchanged (the same object reference — this is what makes
serialization provably unaffected, since the child's own subtree is never
touched, only skipped for the purposes of anchoring and `interiorTexts`
collection), contributes nothing to `interiorTexts`, and is never recursed
into. `hiddenSubtrees` is required on the two inner functions
(`transformInteriorParagraphs`, `transformChildren`) and optional-defaulted
to `new Set()` only at the public entry point
(`anchorInteriorParagraphs`), so `buildTableObject`'s existing call site
(`anchorInteriorParagraphs(normalized)`, no text-box concept in play)
needed zero edits.

**5. Shared object metadata comes from the first VISIBLE entry.** Where a
host paragraph carries multiple text boxes, `kind`/`floating`/generation
metadata for the resulting `CapturedBodyObject` is now derived from the
first entry whose `hiddenFlags` value is `false`
(`hiddenFlags.findIndex((hidden) => !hidden)`, bounds-guarded rather than a
non-null assertion), not simply the first entry regardless of visibility.
This is a deliberate, documented behavior change from the pre-#515
implementation: previously, if the first text box in document order
happened to be the hidden one, its metadata (not the visible box's) drove
the whole paragraph's captured object. Flagged here for reviewer visibility
since it changes output for any existing fixture where box order and
visibility order disagree.

**6. All-hidden paragraph handling is unchanged, now decided correctly.**
When every text box in the paragraph is hidden
(`hiddenFlags.findIndex` returns `-1`), the paragraph produces no object —
same as before #515 — except the decision now genuinely reflects ALL boxes
rather than accidentally reflecting only the first. The existing
vanish-paragraph exception (host paragraph itself `w:vanish` → don't report
co-occurring drawables as dropped) is unchanged.

## Consequences

- A host paragraph mixing a hidden and a visible text box now round-trips
  correctly in both directions: the visible box's interior text is captured
  and addressable; the hidden box's interior text never leaks into
  `interiorTexts`, and its OOXML is preserved byte-identical (opaque
  pass-through, per ADR-072 decision 1) rather than being anchored or
  dropped.
- No public/exported struct changed — `CapturedBodyObject`,
  `CapturedParagraphObject`, `ParagraphDrawingResult`, and friends are
  byte-for-byte unchanged. This is a read-path/internal-correlation fix
  only; `hiddenFlags: []` (the pre-#515 shape, one paragraph one text box)
  preserves today's exact behavior.
- The pre-existing `dropped: []` whenever a text-box object IS built (as
  opposed to the all-hidden branch, which computes `dropped` for real) is
  unchanged by this ADR — it is a pre-existing quirk, out of scope for
  #515.
- The positional-correlation mechanism this ADR introduces
  (`resolveHiddenTxbxContentNodes`) is now the second place in this module
  family that reconciles grouped-mode and `preserveOrder`-mode trees by
  document order rather than shared identity (the first being
  `alternate-content.ts`'s AC normalization, ADR-072 decision 19). Any
  future signal that needs to move information from the `raw` tree to the
  blob tree should default to this same document-order correlation
  pattern rather than inventing a new one, and should re-spike the
  fail-closed guard's reachability against the fixture corpus before
  assuming it stays unreachable.
- ADR-072 addendum 20's open WS3 questions (nested table/text-box
  promotion and disambiguation) are unaffected — this ADR does not touch
  what gets promoted to its own `object`, only how visibility is decided
  per text box within an already-scoped host paragraph.
