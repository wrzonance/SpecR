# Private local gold-corpus runner — design

**Issue:** #426 · **Relates to:** ADR-055 (hierarchy confidence), WS2 #424 (`buildHierarchyReport`), the `fixture:snapshot/diff` harness (PR #368) · **Pressure-phase WS3** · **Date:** 2026-07-08

## Goal

A binary pass/fail veto over the local reference corpus that operationalizes the standing rule —
*every inference change must re-validate the corpus (3 parts, no note-leak, sane structure)* — into a
command the maintainer runs before merging inference changes. It compares each file's parse to a
**user-blessed** fingerprint and exits non-zero on any regression. **Never touches the cloud.**

## Context (the gap)

- The copyrighted `.docx` corpus lives under `docs/references/**` and is **gitignored**
  (`.gitignore`: `docs/references/**/*.docx`). Only the public-domain UFGS `.SEC` files are committed.
- Therefore the two inference safety nets **skip in cloud CI**:
  - `src/parser/docx/corpus-parts.integration.test.ts` — `describe.skipIf(CORPUS.length === 0)`; the
    "every real spec → 3 visible parts, invalid rejected, fragments tolerated" invariant runs only
    where the docs are present (locally).
  - `fixture:snapshot`/`fixture:diff` (`scripts/fixture-ab.ts`, `src/lib/fixture-snapshot.ts`) — the
    A/B snapshot-diff harness, likewise local-only.
- A change that breaks real-spec parsing passes CI green. There is no absolute, blessed baseline the
  maintainer can veto against.
- **The fingerprint substrate exists:** `fixture-snapshot.ts` computes `{ parts, noteLeaks, refs,
  render }` per file with `diffSnapshots`; `countNoteLeaks` is reusable. `.SEC` parses via explicit
  XML and does **not** exercise the DOCX 5-signal inference engine — the actual regression surface —
  so the corpus that matters most is exactly the gitignored `.docx` set.
- **Feasibility confirmed:** `makeNode` (`src/parser/docx/inference.ts:344-351`) attaches
  `meta.inference` (confidence via the pure `scoreHierarchyConfidence`, ADR-055) at **parse time**, so
  `buildHierarchyReport(parsedTree, source)` runs directly on a freshly-parsed file — confidence-band
  fingerprints need **no DB**.

## Decisions (locked in brainstorming)

1. **Scope:** a **private LOCAL runner** only — never a cloud CI job (keep it simple). No new API, no
   encryption. The public synthetic-DOCX CI tier is deferred to a later slice.
2. **Fingerprint:** **structural + confidence bands** (coarse — counts/bands, not exact scores/render).
3. **Baseline:** **user-validated gold per file** — the maintainer blesses a file's fingerprint after
   visually confirming the parse in the web UI. Only **blessed** entries are gated; coverage grows as
   files are blessed.
4. **Bless mechanism:** CLI (`gold:bless`), not a web-UI button (no new endpoint).

## Architecture

```
docs/references/**/*.{docx,sec,SEC}   (gitignored .docx present only locally)
        │  parse()  (tree carries meta.inference at parse time)
        ▼
computeFingerprint(tree, refs, source)      ← src/lib/gold-fingerprint.ts (NEW)
        │  reuses fixture-snapshot primitives + buildHierarchyReport (WS2)
        ▼
GoldFingerprint { section, parts, noteLeaks, maxDepth, partShape, confidenceBands }
        │
   ┌────┴───────────────────────────┐
   ▼                                 ▼
gold:verify  → compare to blessed    gold:bless [glob] → write current as blessed
   → non-zero exit on any deviation      (run after web-UI confirmation)
   (binary veto)                      gold/expectations.json  (committed — facts, Feist-safe)
```

## Component 1 — fingerprint (`src/lib/gold-fingerprint.ts`)

```typescript
export interface GoldFingerprint {
  readonly section: string;          // parsed CSI section number
  readonly parts: number;            // visible (non-vanish) part-type root count — the 3-part red flag
  readonly noteLeaks: number;        // specifier-note leakage count (reuse fixture-snapshot.countNoteLeaks)
  readonly maxDepth: number;         // deepest normalized ilvl reached
  readonly partShape: readonly number[][]; // per visible part: [articleCount, pr1Count, …] structural shape
  readonly confidenceBands: { readonly high: number; readonly review: number; readonly low: number };
}
// Bands: scored paragraphs bucketed around HIERARCHY_REVIEW_THRESHOLD (0.6) —
//   review = confidence < threshold; a second low cut (e.g. < 0.3) splits review/low; rest = high.
export function computeFingerprint(
  tree: SpecTree, refs: readonly SecRef[], source: string | null,
): GoldFingerprint;
```

- Pure over the parsed tree (no DB, no I/O). Reuses `countNoteLeaks` and the parts logic from
  `fixture-snapshot.ts` (import/extend — do not duplicate); computes bands via `buildHierarchyReport`.
- **Coarse by design:** counts + bands, never exact confidences or rendered markdown, so benign
  score jitter or a whitespace tweak does not force a re-bless.

## Component 2 — gold store (`gold/expectations.json`, committed)

```typescript
export interface GoldEntry {
  readonly fingerprint: GoldFingerprint;
  readonly source: string | null;      // vendor label at bless time (annotation)
  readonly blessedAt: string;          // ISO date the maintainer blessed it
  readonly note?: string;              // optional human note (e.g. "known CPI ilvl offset")
}
export type GoldStore = Record<string, GoldEntry>;   // keyed by corpus-relative file path
// Key = the file's path under docs/references/ (POSIX-normalized), NOT the section number:
// ARCAT and CPI both ship section "09 91 26", so a section key would collide across vendors.
```

- Fingerprints are **facts** (Feist v. Rural — facts are not copyrightable), so committing them is
  clean while the source docs stay gitignored. Zod-validated on read; a corrupt store fails loud.
- **Only blessed entries are gated.** A corpus file with no entry is *ungated* (reported, not failed).

## Component 3 — `pnpm gold:verify` (`scripts/gold.ts verify`)

- Glob `docs/references/**/*.{docx,sec,SEC}` (same set as `snapshotCorpus`), parse each, compute its
  fingerprint, and compare to its blessed `GoldEntry`.
- **Exit non-zero on any deviation from a blessed entry** (the binary veto), printing a clear per-file
  field diff (expected vs actual) for every mismatch — the "fix-loop reads this" surface.
- Un-blessed corpus files → a coverage summary line (`N gated, M ungated`), **not** a failure.
- Blessed entries whose file is absent locally → reported as `missing-locally`.
- **No corpus present → exit 0 with a skip notice** (mirrors `corpus-parts`), so it is a clean no-op
  in any cloud context and never leaks a requirement to ship the docs.
- Honors the documented exceptions the corpus test already encodes (fragment/invalid files) via the
  gold entry (a fragment is blessed with its real `parts`, an invalid file is not a corpus member).

## Component 4 — `pnpm gold:bless [glob]` (`scripts/gold.ts bless`)

- Compute the current fingerprint for each matched corpus file and write/update it as a blessed
  `GoldEntry` (stamping `blessedAt`; preserving any `note`). Default glob = whole corpus; a narrow glob
  blesses one section.
- The maintainer runs this **after** visually confirming the parse is correct in the web UI (the
  existing round-trip). This is the "user-validated gold per file" step — the tool never auto-blesses
  on `verify`.
- Re-blessing an existing entry overwrites its fingerprint (an intentional accept-the-new-truth after
  a reviewed inference change).

## Component 5 — docs + ADR

- **ADR** (`docs/adr/057-gold-corpus-runner.md` — 056 is WS1's logging ADR): local-only/never-cloud rationale; facts-are-commit-
  safe; blessed-only gating; coarse confidence bands; why complementary to `fixture:diff`.
- **Workflow doc** (README section): the bless loop (open spec in demo → confirm correct →
  `gold:bless <section>`) and "run `gold:verify` before merging any inference change — it's the veto."

## Relationship to `fixture:snapshot/diff`

Complementary, not a replacement:

| | question answered | truth source |
|---|---|---|
| `fixture:diff` | *did my change move any fixture?* | A/B (two snapshots, no ground truth) |
| `gold:verify` | *does the corpus still match blessed truth?* | committed **blessed** fingerprints |

`gold-fingerprint` reuses `fixture-snapshot`'s primitives (`countNoteLeaks`, parts) rather than
duplicating them.

## Invariants → tests (unit, synthetic trees — run in CI without the corpus)

1. `computeFingerprint` is deterministic and pure: the same tree → the same fingerprint.
2. `gold:verify` **passes** when the computed fingerprint equals the blessed one; **fails (non-zero)**
   on any single field deviation (part count, note-leak, depth, shape, or a band shift).
3. `gold:verify` treats an un-blessed corpus file as *ungated* (counted, not a failure).
4. `gold:bless` writes a blessed entry with the current fingerprint; a subsequent `verify` passes for it.
5. The gold store round-trips through its Zod schema; a corrupt/short store fails loud (not silent).
6. Confidence bands bucket correctly around the threshold (a paragraph at `< 0.6` lands in `review`/`low`).
7. No corpus present → `verify` exits 0 with a skip notice.

Corpus-dependent behavior (parsing real docs) is exercised only where the corpus is present (local),
like `corpus-parts`; the unit tests use synthetic trees so they run everywhere.

## Out of scope (deferred)

- The **public synthetic-DOCX CI tier** (copyright-clean generated fixtures wired into `ci.yml`).
- A **web-UI bless button** (needs an API endpoint).
- A **git pre-push hook** invoking `gold:verify`.
- **Canary GUID / rotation** of the private corpus.

## File map

| File | Change |
|------|--------|
| `src/lib/gold-fingerprint.ts` | **new** — `GoldFingerprint`, `computeFingerprint`, band bucketing |
| `src/lib/gold-fingerprint.test.ts` | **new** — determinism, bands, shape |
| `src/lib/gold-store.ts` | **new** — `GoldStore`/`GoldEntry` + Zod schema, read/write |
| `src/lib/gold-store.test.ts` | **new** — Zod round-trip, corrupt-store fails loud |
| `scripts/gold.ts` | **new** — `verify` + `bless` subcommands (glob, parse, compare, exit code) |
| `gold/expectations.json` | **new** — committed blessed store (starts empty/curated) |
| `package.json` | add `gold:verify` + `gold:bless` scripts |
| `docs/adr/057-gold-corpus-runner.md` | **new** — ADR |
| `README.md` (or docs) | bless-loop + verify-before-merge workflow |
