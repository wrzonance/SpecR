# ADR-060: `.SEC` egress filters owner-removal — filter, don't encode

## Status

Accepted (2026-07-10).

Closes the #278 gap: the `.SEC` renderer (`src/generator/sec/index.ts`) did not honor
owner-removal (`meta.vanish`, #251/ADR-022), so a removed body paragraph re-appeared on a
`.SEC` round-trip.

Depends on / relates to: ADR-048 (model-driven multi-format egress — every renderer derives from
the canonical AST and honors the resolved model), ADR-022 (`#251` reversible paragraph removal),
ADR-030 (soft-delete symmetry). Concerns: `#278`.

## Context

- `#251` (ADR-022) added **reversible owner-removal**: the `/removal` endpoint sets `meta.vanish`
  on a body paragraph, which suppresses it from the **owner-facing renders**. The DOCX generator
  (`emitNode` returns `false` → `collectParagraphs` does not recurse) and the Markdown renderer
  (`renderNonStructural` returns `''` before recursing) both drop a vanished non-note node **and its
  whole subtree**. A `note` is the one exception both keep — it always renders.
- The `.SEC` generator honored `vanish` only for **continuations** and **roots**; a vanished
  structural body node (`pr1`–`pr7`, or an article) was written as an ordinary
  `<SPT>/<LST>/<ITM>`. `parseSec(generateSec(tree))` therefore returned the node with `vanish`
  unset — removal did not survive the round-trip, and the removed text re-appeared.
- **The semantic collision.** In `.SEC`, the hidden marker is not free: the SEC parser already sets
  `vanish: true` for `<NTE>` (specifier note) elements. Owner-removal and the note marker overlap on
  one concept, so `.SEC` cannot *naively* round-trip owner-removal — a vanished body node and a note
  would be indistinguishable on re-parse.
- This was **latent**: there is no user-facing `.SEC` **export** endpoint. `generateSec` is used only
  by parser round-trip tests, so removed content could not leak to a user via `.SEC` today. `#278`
  asks that the gap be closed **before** a `.SEC` export ships, and names the fork below.

## Decision

**Filter owner-removed body nodes from `.SEC` egress; do not encode a distinct removal marker.**

A single `isHidden(node)` predicate — `node.type !== 'note' && node.meta.vanish === true` — is applied
at every `.SEC` render site (roots, part children/articles, and structural children). A hidden node,
with its whole subtree, is dropped; a `note` is never filtered (SEC notes are `vanish` by definition
and always export as `<NTE>`). Leaf detection consults the same predicate: a node whose children are
*all* hidden is a leaf after filtering, so it emits the correct childless `<LST>/<ITM>` element rather
than a nested `<SPT>` that would re-parse one tier shallower — the filter governs structure as well as
content. This makes the three model-driven owner-facing renderers — DOCX, Markdown, `.SEC` — behave
identically: **removed content appears in no exported document.**

**Rejected alternative — encode an owner-removal marker** (true lossless reversibility through
`.SEC`): rejected because it would (a) **collide** with the established `<NTE>`/`vanish` note mapping,
forcing a disambiguation channel; (b) **invent a non-standard SpecsIntact marker** that no real
SpecsIntact consumer understands, defeating the point of emitting canonical `.SEC`; and (c) buy
lossless reversibility that **nothing requires** — `.SEC` is import-only today, and removal is already
reversible in the system of record (the DB row and its subtree stay intact, `removed: false` restores
it; ADR-022/ADR-030). Filtering is the AST-honoring choice consistent with ADR-048: the canonical AST
is the source of truth, and every render derives from it.

## Consequences

**Positive**

- `.SEC` joins DOCX and Markdown as a removal-aware, model-driven render — a `.SEC` export (when it
  ships) cannot leak owner-removed content. `#278`'s acceptance criteria are met.
- The rule is single-sourced in one `isHidden` predicate, so a future render site inherits it by
  construction rather than re-deriving the note/vanish special-casing.
- No non-standard `.SEC` marker is introduced; output stays canonical SpecsIntact.

**Costs / boundaries**

- Owner-removal is **not** round-tripped back as `vanish` through `.SEC` (by design — it is a filter).
  A `.SEC` re-import of an exported file yields a tree without the removed paragraph, not a tree that
  re-marks it removed. Reversibility lives in the DB (ADR-022/ADR-030), not in the `.SEC` bytes.
- `.SEC`-origin trees are unaffected: a parsed `.SEC` carries `vanish` only on notes (kept), never on
  body nodes, so the existing round-trip faithfulness contract for `.SEC`-origin trees is preserved.
- The separate `#296` limitation stands: root-level `<NTE>`/`<TXT>` chrome on a DOCX-origin tree is
  emitted but not re-parseable (parser rebuilds roots only from `<PRT>`); that fix is parser-side and
  out of scope here.
