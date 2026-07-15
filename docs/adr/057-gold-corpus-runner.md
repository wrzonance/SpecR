# ADR-057: Private local gold-corpus regression gate

## Status

Accepted (2026-07-08). Pressure-phase WS3. Implements #426. Builds on ADR-055
(hierarchy-inference confidence) and the WS2 hierarchy-scoring report (#424).

## Context

The copyrighted `.docx` reference corpus is gitignored (`docs/references/**/*.docx`),
so the two existing inference safety nets — the `corpus-parts` integration test and
the `fixture:snapshot`/`fixture:diff` A/B harness — skip in cloud CI and run only
where the docs are present. A change that breaks real-spec parsing can therefore pass
CI green, and there is no absolute, maintainer-blessed baseline to veto against.

## Decision

Add a private, local-only runner:

- **`pnpm gold:verify`** parses every corpus file, reduces each to a coarse
  `GoldFingerprint` (`section`, visible `parts`, `noteLeaks`, `maxDepth`, per-part
  structural `partShape`, and low/review/high `confidenceBands`), and compares it to a
  blessed baseline. It exits non-zero on any deviation from a blessed entry — a binary
  veto the maintainer runs before merging inference changes.
- **`pnpm gold:bless [glob]`** writes the current fingerprint as the blessed baseline,
  run only after the maintainer has visually confirmed a parse in the web UI.
- The baseline lives in **committed** `gold/expectations.json`. Fingerprints are facts
  (Feist v. Rural — facts are not copyrightable), so committing them is clean while the
  source docs stay gitignored. Only blessed entries gate; coverage grows as files are
  blessed.
- **Never wired into cloud CI** — no `.github` workflow invokes `gold:verify`; it is a
  maintainer command run by hand. (The gitignored `.docx` corpus isn't present in CI
  anyway, and the runner no-ops entirely when `docs/references` is absent — but note the
  public UFGS `.SEC` corpus _is_ committed, so that guard would not itself fire in CI; the
  gate stays out of CI because nothing there calls it, not because the directory is empty.)

The fingerprint reuses `fixtureRecord` (parts/note-leak) and `buildHierarchyReport`
(confidence bands) rather than duplicating either, so it cannot drift from the renderers
or the WS2 report.

**Update 2026-07-15:** the purpose-built visual-confirmation instrument for blessing is now the
round-trip harness at `tools/verify` (#150/#305) — reference vs round-trip vs region-scoped pixel
diff, headers/footers included. The linkage remains workflow-level only; the harness and the gold
runner stay deliberately uncoupled in code (the harness needs a browser + the REST API + a database,
while `gold:verify` stays fast, headless, and structural). The "visually confirmed a parse in the
web UI" step above is served by that harness; `gold:bless` is still run separately by hand.

## Consequences

- Inference regressions on real specs are caught locally by an explicit veto, not left
  to a test that silently skips.
- Bands and counts are coarse by design, so benign score jitter or whitespace changes do
  not force a re-bless; a genuine structural or confidence-distribution shift does.
- The maintainer must bless deliberately (after visual confirmation); an un-blessed file
  is reported but never gates.
- Complementary to `fixture:diff`: that answers "did my change move any fixture?" (A/B,
  no ground truth); `gold:verify` answers "does the corpus still match blessed truth?".

## Out of scope (deferred)

A public synthetic-DOCX CI tier, a web-UI bless button, and a git pre-push hook.
