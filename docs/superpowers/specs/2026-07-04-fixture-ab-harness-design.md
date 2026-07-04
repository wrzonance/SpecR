# Fixture A/B harness — design

- **Date:** 2026-07-04
- **Status:** Approved (pending implementation plan)
- **Owner:** thewrz
- **Related:** ADR-020 (section-number grammar), `corpus-parts.integration.test.ts`, PR #367 (the fixes whose verification motivated this)

## Context

The inference/parsing engine is the product. A one-character regex or signal tweak can silently
reshape how hundreds of gitignored fixtures parse — reorder a list, flip a note to body text,
drop a reference. Per-file unit tests do not catch corpus-wide drift.

This session hardened three parsing/display defects and, to prove each change was **surgical**,
used a throwaway before/after harness: snapshot every fixture's parse output, make the change,
re-snapshot, diff. The diff showed exactly what moved (e.g. "23 ARCAT lines flipped
continuation→note, every other fixture byte-identical") and surfaced would-be collateral before
it shipped. That tool is load-bearing for every future parser change and should stop being
throwaway.

**What already exists:** `src/parser/docx/corpus-parts.integration.test.ts` is a committed,
fixture-gated test (`describe.skipIf(CORPUS.length === 0)`) asserting every real spec parses to
the standard 3 parts, with a documented FRAGMENTS/INVALID exception set. It skips in CI (the docx
corpus is copyrighted and gitignored) and runs locally where the files are present.
`arcat.integration.test.ts` uses the same `existsSync`-gated pattern.

**What is missing:**
1. The **before/after diff** capability — a two-run comparison that shows *what a change dragged
   in*, not just whether an absolute invariant still holds.
2. A **note-leak** assertion — the existing corpus test checks part count only, not that
   specifier-note banners render as `> **[NOTE]**` blockquotes (the exact form
   `renderMarkdown` emits) and never as CSI body.
3. A written **contributor rule** — "A/B the corpus before any parsing-regex change" lives only in
   an agent's memory.

**Copyright constraint (shapes the whole design):** a snapshot is derived from the copyrighted,
gitignored docx (it embeds rendered markdown of their content). A committed baseline would embed
that content, so **the baseline stays local and gitignored; only the script is committed.**

## Goals

- A committed, reusable tool that reproduces this session's before/after diff workflow.
- Formalize the note-leak half of the standing rule as a real (fixture-gated) assertion.
- Document the rule so contributors and agents follow it.

## Non-goals (YAGNI)

- No committed golden manifest (would embed copyright-derived data; also rejected by the user in
  favor of the local-only shape).
- No CI wiring — the docx corpus is absent in CI, so the tool is inherently local. The `.sec`
  corpus is committed, so the tool still produces a partial snapshot in a fresh clone, but we do
  not add a CI job.
- No git-stash automation (stash races across worktrees are a known footgun).
- No `.sec`-specific assertions beyond what the shared parse path already exercises.

## Design

### Component 1 — the A/B tool (`scripts/fixture-ab.ts` + pure logic in `src/`)

A thin CLI with two subcommands. The snapshot-record builder, diff logic, and banner matcher live
under `src/` (exact home decided in the implementation plan); `scripts/fixture-ab.ts` is only the
argv/IO wrapper, importing from `src/` the way `scripts/load-files.ts` already does. This split is
forced, not stylistic: vitest's unit project only picks up `src/**/*.test.ts`, and a `src/` test
cannot import from `scripts/` (`rootDir: "src"` — `pnpm build` compiles `src/` tests and errors on
out-of-root imports), so the "unit-testable without the corpus" promise below and the matcher
sharing with Component 2 both require the logic to live in `src/`. (`scripts/**` is outside the
`pnpm lint` sweep — `eslint src/` — and its eslint block relaxes `no-console` only; the pure logic
in `src/` obeys the full lint budget.)

**`pnpm fixture:snapshot <label>`**
- Globs `docs/references/**/*.{docx,sec,SEC}` (both formats; `.sec` is committed so it always
  contributes, docx only when present locally).
- For each file: `parse()` → `renderMarkdown(tree)`. Records per fixture:
  - `parts` — count of visible part-type root nodes (the 3-part signal).
  - `noteLeaks` — count of rendered lines that contain a specifier-note **banner** but are **not**
    a `> **[NOTE]**` note line. Matched contains-style (anywhere in the line, not just line-start),
    case- and decoration-insensitively, mirroring **both** parser patterns in
    `src/parser/docx/heuristics.ts` (`NOTES? TO (THE )?SPEC(IFIER|S| WRITER)?S?` and
    `SPEC(IFIER)?S? NOTES?`) so every variant the parser recognizes ("NOTES TO SPEC WRITER",
    "SPEC NOTES", …) is covered — a matcher narrower than the parser's would go blind exactly where
    the parser regresses. Those patterns are already mirrored into migration 024 (ADR-022 D3) with
    a keep-in-sync note; this matcher joins that sync set (or imports a shared export — implementer's
    call). Contains-style matching also catches the Fix A toggle line ("Display hidden notes to
    specifier…"). A non-zero value is a real leak.
  - `refs` — sorted list of extracted refs from the `parse()` result (`SecRef` is a discriminated
    union: record `targetType` plus `targetSpecSection` for section refs / `standardCode` for
    standard refs — note the field is `targetSpecSection`, not `targetSection`), so reference-regex
    changes, e.g. the strong-context section-number work, are diffable too.
  - `render` — the full markdown (line-level diff source; local/gitignored, so embedding
    copyrighted content is acceptable exactly as the docx themselves already are).
  - `error` — the parse error message when a file is rejected (corrupt/non-docx).
- Writes `.fixture-snapshots/<label>.json`.
- If `docs/references` is absent, prints a clear message and exits 0 (never a hard failure).

**`pnpm fixture:diff <a> <b>`**
- Loads two snapshots and, for every fixture whose record differs, prints the `parts` / `noteLeaks`
  / `refs` deltas and the added/removed `render` lines, then a `N/total changed` summary. Fixtures
  present in only one snapshot are flagged (corpus added/removed between runs).
- Pure comparison over two JSON inputs — unit-testable without the corpus.

**Workflow (the whole point):**
```
pnpm fixture:snapshot before      # known-good baseline
# …tweak the regex / signal…
pnpm fixture:snapshot after
pnpm fixture:diff before after    # only the intended fixtures should move
```

### Component 2 — note-leak invariant (extend `corpus-parts.integration.test.ts`)

Add, alongside the existing 3-part assertion, a per-fixture check: render the spec to markdown and
assert **no specifier-note banner** appears on a non-`> **[NOTE]**` line. The banner matcher is
imported from its `src/` home (Component 1) so the two agree by construction. Prefer folding the
check into the existing per-fixture `it()` (or caching the parse) — a separate `it()` re-parses
all ~36 local docx and doubles the sweep's runtime for no coverage gain.

Scoped to **banners** deliberately: the open **#292** asterisk-`[OR]` option-delimiters render as
visible content but are not banners, so this assertion stays green on them (they are tracked
separately) while locking in the Fix A behavior ("Display hidden notes to specifier" → note).

**Sequencing:** this assertion passes only with Fix A present, so it lands **after PR #367 merges**
(or is rebased onto it). The implementation plan orders Components 1 and 3 first (independent) and
Component 2 after #367.

### Component 3 — `.gitignore` + `CONTRIBUTING.md`

- `.gitignore`: add `.fixture-snapshots/`.
- `CONTRIBUTING.md`: a new **"Changing the parser? A/B the corpus first"** section stating the
  standing rule (any parsing-regex or inference change → snapshot before, change, snapshot after,
  diff; verify only the intended fixtures moved, all real specs still 3-part, no banner leak), the
  three commands, and the note that the corpus is gitignored so the tool runs locally.

## Testing

- **Diff logic** (Component 1) — unit-tested with two hand-authored in-memory snapshots covering:
  unchanged fixture, changed `render`, changed `parts`, changed `refs`, note-leak delta, and a
  fixture present in only one side. No corpus needed. Tests live in `src/` next to the pure logic
  (the unit project's `src/**/*.test.ts` glob is why the logic can't live only in `scripts/`).
- **Snapshot I/O** — a smoke test that snapshotting a single committed `.sec` fixture writes a
  well-formed record; the writer takes an output directory parameter so the test targets a temp
  dir, not `.fixture-snapshots/`. The heavy end-to-end sweep is the manual workflow, not a CI test.
- **Note-leak invariant** (Component 2) — rides the existing fixture-gated integration lane; skips
  in CI, runs locally.

## Risks / non-obvious decisions

- **Banner-scoped leak check** — chosen over "any specifier-note text" so #292 doesn't turn the new
  assertion red before it is fixed. Documented in the test.
- **Local-only baseline** — no persistent regression guard; drift is caught only when a contributor
  runs the tool. Accepted: the committed 3-part test is the always-on guard; this tool is the
  surgical-diff instrument for intentional changes.
- **`render` embeds copyrighted text** — mitigated by keeping snapshots gitignored (identical
  posture to the docx corpus itself); the committed script contains none.
- **Snapshot size** — full renders of the whole corpus (666 committed `.sec` + ~36 local docx,
  ~60 MB of sources) put each snapshot JSON in the tens of MB. Acceptable for a local, gitignored
  artifact; noted so nobody "optimizes" the render field away — it is the line-diff source.
