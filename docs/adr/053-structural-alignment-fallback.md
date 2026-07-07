# ADR-053: Structural alignment fallback for cross-spec comparison

## Status

Accepted

## Context

ADR-047 shipped the first slice of `src/reporting/`: a cross-spec comparison that
aligns two live specs strictly by **resolved origin** (`keyOf(p) = originParagraphId
?? id`). That works when the two specs descend from a shared master — a clone carries
`origin_paragraph_id = <master paragraph id>`, so counterparts share a key. It was an
explicit non-goal of that slice to align specs that share no origin.

The flagship demo scenario — "summarize the differences of this spec between these two
projects" — breaks under that constraint the moment the two projects ingested their
spec **independently** (e.g. two DOCX of the same CSI section parsed into two libraries).
Independently-parsed paragraphs get fresh `gen_random_uuid()` ids and `NULL` origins, so
every origin key is unique and *nothing* aligns: the whole matrix collapses to only-in-X
on both sides. This ADR lifts ADR-047's fuzzy/content-alignment non-goal with a
**deterministic structural fallback** — not fuzzy matching, not embeddings.

Two secondary gaps blocked agent consumption of the tool over `compare_specs`:

- **No differences filter.** The tool returned the full verbatim matrix; a real section
  can exhaust a demo agent-loop token budget (~120k) before the model can summarize.
- **No summary rollup.** The agent had to count states across hundreds of rows to answer
  "how different are they?".

## Decision

1. **Structural address as the fallback key.** When aligning by structure, a paragraph's
   key is the root-to-node path of `nodeType:ordinal` segments (joined by `|`, e.g.
   `part:0|article:1|pr1:0`), where **ordinal = the node's 0-based index among its
   same-`nodeType` siblings** in the loader's `(position, id)` order. In a well-formed CSI
   tree each level is type-homogeneous for numbered nodes (all articles under a part, all
   `pr1` under an article), so this equals the CSI ordinal that render-derived numbering
   uses; interleaved notes/continuations are a different `nodeType` and so never shift a
   numbered sibling's ordinal — the same invariant `consumesNumber` enforces in the
   renderer (`src/ast/labels.ts`). No rendered label is ever stored or compared — numbering
   stays render-derived (the CLAUDE.md rule and #122). Two structurally-identical trees
   produce identical address strings for corresponding nodes, so the address is comparable
   across independently-ingested sources; paragraph ids are globally unique, so a single
   merged `id → address` map serves all sources.

2. **`alignment: 'origin' | 'structure' | 'auto'` (default `auto`).** `auto` picks
   `origin` iff the two sources **share at least one cross-source origin key** (some
   `originParagraphId ?? id` value occurs in ≥2 sources — true for shared-master clones and
   for project↔its-own-master). With no shared origin it falls back to `structure` **only
   when the sources are the same CSI `section`**; different-section pairs stay on `origin`
   so their coincidentally-identical structural addresses (`part:0|article:0`) are not
   falsely paired — they surface as only-in-X on each side instead. An explicit
   `alignment: 'structure'` still applies across sections (the gate guards only the `auto`
   fallback). The mode actually used is echoed back as `alignedBy`. The pure aligner reuses
   ADR-047's Map-hash-join + first-occurrence sweep unchanged; only the keyer is swapped, so
   origin behavior is byte-identical for `alignment: 'origin'` and for shared-master pairs
   under `auto`.

3. **`include: 'all' | 'differences'` (default `all`).** `differences` returns only rows
   that are **not identical** — a row is identical iff present in every column with equal
   text; anything else (modified, or present in only some columns) is a difference. The
   filter trims the returned matrix rows and the baseline-lens rows in lockstep.

4. **`summary` always emitted, grounded on the FULL matrix.** Overall
   `{ rows, aligned, identical, differing }` (`aligned` = present in ≥2 columns;
   `differing = rows − identical`) plus per-column `{ specId, present, onlyIn }`. Because
   the summary is computed before the `include` filter, an agent can request only the
   differing rows yet still cite true totals ("12 of 340 rows differ") without paging the
   whole matrix.

5. **Determinism (ADR-047 carried forward).** The loader's `(spec_id, position, id)` order
   plus the same-type-sibling ordinal and the first-occurrence key sweep fully determine
   both the structural addresses and the row order. No randomness anywhere in the reporting
   path. A pure unit regression pins `run1` deeply equal to `run2` under `structure`.

## Consequences

- **Accepted ambiguity — ordinal shift on insertion.** Structural alignment keys on
  ordinal position within a tier. If one source inserts a new sibling, every downstream
  ordinal shifts, so counterparts after the insertion mispair by one (and the last one
  surfaces as only-in-X). This is the deliberate cost of a *deterministic, content-blind*
  fallback and is accepted for this slice — pinned by a `// KNOWN AMBIGUITY` test. Content-
  similarity alignment (edit distance, embeddings) that would recover from insertions
  remains a non-goal.
- Under `structure`, `ComparisonMatrixRow.originId` carries a structural-address string
  rather than a paragraph UUID. It remains a stable, deterministic row key; consumers that
  treated `originId` as a UUID must not assume that under `structure` mode (documented in
  `openapi.yaml`).
- A single-source `alignTrees` call now resolves `auto` to `structure` (a lone source has
  no cross-source origin overlap); callers wanting origin-collision semantics pass
  `alignment: 'origin'` explicitly. The real endpoint always supplies two sources, so its
  behavior is unchanged.
- All response additions (`summary`, `alignedBy`) are additive and back-compat; the MCP
  `compare_specs` tool and REST `POST /reports/compare` stay contract-bound (ADR-044/045),
  and `openapi.yaml` is the authoritative shape.
- Non-goals from ADR-047 stand: N>2 sources, frozen package/revision sources, cross-master
  multi-hop common-ancestor resolution, and fuzzy/content-similarity alignment.
