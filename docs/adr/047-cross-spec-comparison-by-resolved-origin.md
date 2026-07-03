# ADR-047: Cross-spec comparison by resolved origin

## Status

Accepted

## Context

Issue #351 needs a grounded, deterministic cross-spec comparison report: given two
live specs, show — cell by cell — where their paragraphs agree, differ, or are
present in only one. Every fact must trace to a real `specId` + paragraph UUID; no
content may be synthesized or LLM-generated. This is the first narrow slice of the
`src/reporting/` module; PDF/artifact rendering is deferred to #352 (this slice
returns structured JSON only).

Three facts shaped the design:

1. **`computeDiff` (merge) does not fit.** It is pairwise, hardwired to the raw
   `s.uuid`, and shaped around a DOCX `ExtractResult` (base/ours/theirs). Two
   *different* specs never share raw paragraph UUIDs — a clone gets fresh
   `gen_random_uuid()` ids. What they share is the **resolved origin**: every
   cloned paragraph carries `origin_paragraph_id = <master paragraph id>`
   (migration 018, written by `derive.ts::cloneParagraphs`). Forcing base/ours/
   theirs semantics onto an N-column symmetric matrix would need flag-branching —
   a violation of DRY-without-over-abstraction. We reuse the merge **technique**
   (Map-hash-join + presence/equality classification) and the `ParagraphSnapshot`
   idea, not the function.

2. **Frozen package/revision trees lack per-node `origin_paragraph_id`** (it is a
   freeze-time addition, out of scope here). So this slice supports **live project/
   master specs only**. Because those are the only rows in the `specs` table, a
   frozen package/revision id simply is not a `specs` row and 404s at the existence
   guard — the non-goal enforces itself with no special-casing.

3. **CPI ilvl offset is normalized upstream** at parse time (see CLAUDE.md gotcha).
   Alignment keys on origin, not on hierarchy level, so the offset is irrelevant to
   the comparison — a unit test pins that rows with differing `nodeType`/`position`
   but the same origin still align.

## Decision

1. **Align by resolved origin.** `keyOf(p) = p.originParagraphId ?? p.id`. One
   COALESCE covers both supported comparisons with no branching:
   - **project ↔ project (shared master program):** both rows carry
     `origin = masterParagraphId` → same key → aligned.
   - **project ↔ master:** the project row's key is its origin (the master
     paragraph id); the master row has `origin = NULL` → key = its own id (that
     same master paragraph id) → aligned.
   - **NULL origin** (added after cloning, or master paragraph deleted via
     `ON DELETE SET NULL`) → key = own id, unique → surfaces as *only-in-X*.

   Only **one hop** is needed for live-project sources — no recursive origin CTE.

2. **Emit a symmetric comparison matrix** (rows = aligned paragraphs keyed by
   resolved origin, columns = each source, cells = that source's verbatim text or
   an `{ present: false }` sentinel). A present cell **copies** text from a real
   source row, making the "every cell resolves to a real spec + paragraph UUID"
   acceptance criterion true by construction.

3. **The baseline lens is a pure projection** over the finished matrix — designate
   one column and reframe every cell as `baseline / unchanged / added / removed /
   modified / absent`. It is not a second alignment pass and introduces no new
   specIds/UUIDs.

4. **Determinism first.** Stable `ORDER BY spec_id, position, id` in the loader +
   a first-occurrence ordered-key sweep (left-to-right across sources, top-to-bottom
   within each) fully determine row order. No `randomUUID` anywhere in the reporting
   path. A pure unit regression pins `run1` deeply equal to `run2`.

5. **Owner-removed subtrees excluded, empty-text paragraphs retained.** The loader
   reuses the multi-spec generalization of `versions.ts`'s `REMOVED_SUBTREE_CTE`
   (vanish=true, non-`note` roots ∪ descendants) so removed paragraphs surface as
   `absent` — parity with merge/render. But unlike `buildTree`, it **keeps
   empty-text paragraphs**: they are real rows with valid origin links and UUIDs,
   and dropping them would be an untraceable hole in the matrix.

6. **Endpoint gated to exactly 2 sources; aligner is N-general internally.** The
   `POST /reports/compare` request schema requires exactly two spec ids (the two
   supported comparisons). The pure `alignTrees` is written for N columns so #352
   can extend it without a rewrite — this asymmetry is deliberate.

## Consequences

- `computeDiff` is left untouched; the reporting module owns its own aligner.
- A NULL origin collapses three meanings (added-after-clone / origin-deleted / root
  master) — all three correctly surface as *only-in-X*, which is the intended
  behavior for every one of them.
- Package/revision sources, vertical lineage-trace views, N-way beyond the first two
  comparisons, cross-master multi-hop common-ancestor resolution, and fuzzy/content
  alignment are explicit non-goals of this slice.
- The MCP tool `compare_specs` (tier `read`) and REST `POST /reports/compare` are
  contract-bound (ADR-044/045); the openapi schemas are the authoritative shape.
