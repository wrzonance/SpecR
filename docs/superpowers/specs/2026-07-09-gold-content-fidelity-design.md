# Gold-corpus content-fidelity — design

**Issue:** #428 · **Extends:** WS3 gold-corpus runner (#426, ADR-057), `src/lib/gold-fingerprint.ts` · **Pressure-phase WS4 (content-fidelity slice)** · **Date:** 2026-07-09

## Goal

Teach the gold gate to fail on **silent real-paragraph text loss**. WS3's `gold:verify` vetoes _structural_ drift; this slice adds a _content_ dimension so that a real paragraph whose text is quietly truncated — while the node survives at the same level — no longer passes green.

## Context (the gap)

WS3 reduces each parsed corpus file to a coarse `GoldFingerprint`:

```text
GoldFingerprint { section, parts, noteLeaks, maxDepth, partShape, confidenceBands }
```

Every field is **structural** — counts and bands. That catches a lot:

- a real paragraph _disappears_ → a `partShape` count drops → **fails**;
- a real paragraph is _reclassified as a note_ → structural count drops, `noteLeaks` rises → **fails**.

But it is **blind to intra-paragraph text loss**. If a regex strips the tail of a real paragraph (mistaking it for a note) while the paragraph node survives at the same level, **no count changes** — the fingerprint stays green and content is lost undetected. `>3 parts` is the first red flag of a _structural_ failure; silent truncation is the first red flag the current gate cannot see.

The substrate to close it already exists: `computeFingerprint` walks the parsed tree per visible part (`partShapeOf` via `bucketByIlvl`, pruning `vanish`, keyed off the same node types). A content measure is one more walk over the same parts.

## Decisions (locked in brainstorming)

1. **Real content only.** The measure counts _real spec body words_, never editorial/junk. A whole-document count is rejected: it would trip the moment the parser learns to strip junk _better_ (stripped junk leaves the total → gold fails on an _improvement_). Scoping to real content removes that false-positive class.
2. **Character count, whitespace-normalized.** A **character** count (most sensitive to partial-word truncation), computed on text with whitespace runs collapsed to a single space and trimmed — so benign reflow/whitespace jitter never forces a re-bless. Same coarse, facts-only philosophy as WS3's other fields. (Not a content hash — a hash trips on a single benign typo fix; the gold baseline must survive benign edits.)
3. **Per visible part.** Aggregated one number per visible part, parallel to `partShape`, so a diff localizes _which_ part lost text and the measure is robust to intra-part reordering. Total is derivable; not stored.
4. **Re-bless on real-content change (accepted contract).** Because notes/junk are excluded, a _correct_ future improvement that reclassifies currently-real-looking junk into a note (or strips it) lowers a part's `contentChars` and trips the gate — forcing a **re-bless**. That is the gold contract working (any change to blessed truth, better or worse, a human confirms once), and strictly better than a whole-document count that would trip on _every_ junk-handling change.

## What counts as "real content"

Recurse each visible part's subtree, summing the normalized character length of every node's text, with two exclusions:

| Node | Counted? | Why |
|------|----------|-----|
| `part` / `article` / `pr1`…`pr7` | **yes** | structural spec body — headings and paragraph text |
| `continuation` | **yes** | wrapped body text of a real paragraph — real words that can be lost |
| `note` (own text) | **no** | specifier instructions — editorial, not spec body ("junk today") |
| any `vanish` subtree | **no** (pruned) | human/parse-suppressed content, already out of the render |
| `spec` root | **no** | wrapper node, no body text |
| content _outside_ any part (front matter) | **no** (not in scope) | naturally excluded — the measure is per-part, mirroring `partShape`; front-end junk lives here |

Note the content predicate differs from the _structural_ predicate on one node: `bucketByIlvl` treats `continuation` as non-structural (not a level), but its **text is real content** and is counted here. Notes are excluded from both.

Future front-end **tables** (editor-history / revision blocks — firms' "junk today") stay excluded because tables are not modeled yet (#300); when "important tables vs. junk tables" is designed, it plugs into this same real-content predicate.

## Architecture

```text
parsed SpecTree
   │  computeFingerprint(tree, refs)                 ← src/lib/gold-fingerprint.ts (extend)
   ▼
GoldFingerprint { …, partShape, contentChars }       ← contentChars: readonly number[] (NEW, per visible part)
   │
diffFingerprint(expected, actual)                     ← iterates FINGERPRINT_FIELDS; 'contentChars' added → auto-covered
   │
gold:verify → non-zero on any part's contentChars drop (text loss)
gold:bless  → writes contentChars into the blessed entry (facts, committed)
```

## Component — extend `GoldFingerprint` (`src/lib/gold-fingerprint.ts`)

```typescript
export interface GoldFingerprint {
  readonly section: string;
  readonly parts: number;
  readonly noteLeaks: number;
  readonly maxDepth: number;
  readonly partShape: readonly (readonly number[])[];
  readonly confidenceBands: ConfidenceBands;
  readonly contentChars: readonly number[]; // NEW — normalized real-content char count per visible part
}
```

- **`normalizedLen(text)`** — `text.trim().replace(/\s+/g, ' ').length`. Whitespace-normalized character length.
- **`contentCharsOf(node)`** — recurse the subtree; return `0` for a `vanish` subtree (pruned); add `normalizedLen(node.text)` unless the node is a `note` or the `spec` root; recurse all children. (A note's own text is skipped, but its children — should the parser ever mis-nest a real paragraph under one — still count, because those words are real regardless of mis-nesting.)
- **`computeFingerprint`** adds `contentChars: visibleParts(tree).map(contentCharsOf)`.
- **`FINGERPRINT_FIELDS`** gains `'contentChars'`. The existing compile-time exhaustiveness guard (`_MissingFingerprintField extends never`) **forces** this — the file will not type-check until it is added — and `diffFingerprint` then covers the new field with no further change.

## Component — gold store schema (`src/lib/gold-store.ts`)

`GoldFingerprintSchema` gains `contentChars: z.array(z.number())`. The committed store `gold/expectations.json` is currently `{}` (zero blessed entries from WS3), so the additive-required field needs **no migration and no re-bless of existing data** — the first bless after this ships writes the field. (Were entries present, this would be a required re-bless; there are none.)

## Invariants → tests (unit, synthetic trees — run in CI without the corpus)

1. `computeFingerprint` returns `contentChars` with **one entry per visible part**, each equal to the normalized char sum of that part's real content.
2. **Determinism/purity:** same tree → identical `contentChars`.
3. **Note exclusion:** a note carrying text contributes **0**; the note's text is absent from `contentChars`.
4. **Vanish exclusion:** a `vanish` paragraph's text is **not** counted.
5. **Continuation inclusion:** a `continuation` node's text **is** counted (distinguishing content-scope from structural-scope).
6. **Whitespace immunity:** two trees differing only in whitespace runs / trailing spaces produce **identical** `contentChars`.
7. **Text-loss trips (the core regression):** truncating a real paragraph's text lowers its part's `contentChars`, and `diffFingerprint` reports a `contentChars` delta (expected vs. actual). This is the failure the slice exists to catch.
8. **Zod round-trip:** a fingerprint with `contentChars` round-trips through the gold-store schema; the `gold-store.test.ts` `entry()` fixture is updated to include it.

Corpus-dependent behavior (real docs) is exercised only where the corpus is present (local), like WS3; unit tests use synthetic trees so they run everywhere.

## Out of scope (own follow-on slices / issues)

- **Bless-workflow CLI** — a purpose-built "render inference + logs + accept-as-gold" surface, separate from the editor demo.
- **Agent-blindness** — OS-level isolation (separate user, `0700`) so an agent cannot read the source corpus, only committed fingerprints.
- **Project-lifecycle edit-preservation** — the reconciler (#375) + paragraph restructure (#371); deferred, separate track.
- **Tables** as real content (#300); **per-part labeled diff output** (MVP reuses the generic `diffFingerprint` field diff).

## File map

| File | Change |
|------|--------|
| `src/lib/gold-fingerprint.ts` | add `contentChars` field, `normalizedLen` + `contentCharsOf` helpers, extend `FINGERPRINT_FIELDS` |
| `src/lib/gold-fingerprint.test.ts` | add content-fidelity invariant tests (note/vanish/continuation, whitespace, text-loss) |
| `src/lib/gold-store.ts` | add `contentChars` to `GoldFingerprintSchema` |
| `src/lib/gold-store.test.ts` | update the `entry()` fixture to include `contentChars` |
| `docs/adr/058-gold-content-fidelity.md` | **new** — ADR: real-content-only char count, re-bless-on-change, why not whole-doc / hash |
