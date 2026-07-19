# ADR-032: `section_number_format` is a project column, not a scoped profile

## Status

Accepted

## Context

`section_number_format` — the display format for CSI section numbers
(`canonical` `26 05 00.13` / `dots` `26.05.00.13` / `compact` `260500.13` /
`spaced-compact` `26 0500.13`) — was re-decided three times:

1. The mockup "island" carried a bare `projects.section_number_format` column.
   It was **rejected** during the demo↔backend conformance program on the
   standing principle "don't port island migrations without an ADR."
2. The Phase-4 remainder disposition (B2,
   `docs/superpowers/specs/2026-06-23-phase4-remainder-disposition-design.md` §4)
   chose to **defer** persistence and, when eventually built, **fold it into the
   scoped style/output profile (#125)** rather than a bare column. The rationale
   then was YAGNI — the renderer already accepted the format per-`generate` call
   (`GenerateBodySchema`) — plus a general aversion to "another bare formatting
   column."
3. When the format was pulled forward for the project-settings UI, a bare
   `projects.section_number_format` column was **shipped** (#266, migration 035),
   reversing B2.

That left a stale conflict: #266 shipped a column while #250 still said "scoped
profile." The scoped-profile pattern — a JSONB payload + built-in defaults
resolved along a `firm → client → project → package → revision` chain — is the
house pattern for editing conventions (#137), headers/footers (#208),
revision-nomenclature (#209), and visual style (#125).

## Decision

`section_number_format` is persisted as a **bare, CHECK-constrained
`projects.section_number_format` column** — the canonical project-tier home. It
is **not** folded into the scoped style/output profile (#125).

Reasoning:

- It is a **single constrained enum**, not a rich multi-field payload. A `CHECK`
  column is a hard schema guarantee — queryable and indexable; a JSONB profile
  field is app-validated and forfeits those properties for no offsetting benefit.
- **No sub-project tier needs a different value.** Section-number format is a
  house/project-wide choice — one would not issue one package in dots and another
  in spaces. The `package`/`revision` tiers of the resolution chain are dead
  weight for this field.
- It is **its own scalar output policy**, distinct from #125's *visual* style
  payload (number formatting ≠ fonts/spacing/margins). It does not belong inside
  the style JSONB.
- The scoped-profile/JSONB pattern earns its complexity on **open, multi-field**
  settings with genuine per-tier overrides; applying it to one enum is
  over-abstraction (per `code.md`: an abstraction you can't explain in one
  sentence is a liability).

The earlier "fold into the profile" call (B2) was sound **while deferring** the
feature — standing up scoped-profile machinery for a YAGNI setting would have been
premature. Once it became a real persisted setting, the column is the correct,
more definitive choice.

## Consequences

- The project column (#266, migration 035) is the source of truth for a project's
  default section-number format; `PATCH /projects/:id { sectionNumberFormat }`
  sets it; `findProjectById` surfaces it.
- Generate reads the column as the per-project default (#267) rather than
  requiring every caller to pass the format on each request.
- The one genuinely-deferred capability — a **firm/library-level default** that a
  project overrides — now lives on the first-class `clients` entity introduced
  by ADR-054. In SpecR's current hierarchy, a client is the organization above
  projects and therefore the natural firm/library default tier; a separate
  `firms` table would add an unused hop and profile machinery would obscure a
  single constrained scalar. Generation resolves
  `COALESCE(project.section_number_format, client.section_number_format, 'canonical')`.
  Existing project values remain explicit overrides; new projects begin with a
  null override and inherit from their associated client.
- Supersedes the B2 disposition on this specific field and closes out the
  island-migration rejection for it.
- This decision is **scoped to a single constrained enum.** If a future need
  arises for several correlated output settings, or for genuine per-package /
  per-revision output overrides, that is the trigger to introduce a proper scoped
  *output* profile — `section_number_format` alone does not justify one.
