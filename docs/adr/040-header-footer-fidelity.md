# ADR-040: Header/footer 1.0 fidelity — page variants, page-number policy, raw sidecar

## Status

Accepted

## Context

Issue `#208` (migration 030, `header_footer_configs`) introduced a single
header/footer composition shape — `{ header, footer, style }`, JSONB-backed and
open via `.catchall` (ADR-021) — resolved across the client → project → package
→ revision scope chain. That single shape cannot express Word's actual
header/footer model, which 1.0 round-trip fidelity requires:

- **Page variants.** A Word section carries up to three header references and
  three footer references — `default`, `first` (`w:titlePg`), and `even`
  (`w:evenAndOddHeaders`). Specs routinely use a distinct first-page (cover)
  header and duplex even/odd layouts. v1 had nowhere to put them.
- **Page-numbering policy.** Submittal packages number either continuously
  across the whole package or restart at each spec section
  (`w:pgNumType@start`). v1 had no policy field.
- **Unsupported captured OOXML.** A faithful DOCX parser (#306) will encounter
  header/footer markup we do not yet model (`w:fldSimple`, embedded drawings,
  tab-stop geometry). Dropping it silently breaks round-tripping.

The umbrella issue (#301) and #302 cited two design documents that **do not
exist** — `docs/superpowers/specs/2026-06-26-header-footer-fidelity-design.md`
and `docs/adr/039-header-footer-fidelity.md`. ADR-039 is already taken
(`039-offline-ocr-provisioning.md`). This ADR is the real record and supersedes
those phantom references; the issue body's Scope/Acceptance plus the existing
v1 schema were sufficient to implement from.

This ADR covers the **AST schema layer only** (#302). Resolving the effective
config across scopes (#304), rendering a resolved config to DOCX (#303), and
capturing header/footer OOXML during parse (#306) are separate issues.

## Decision

Extend `HeaderFooterCompositionSchema` (`src/ast/header-footer-schemas.ts`)
additively. The v1 `{ header, footer, style }` fields stay at the top level; v2
adds three optional, fully-open fields.

- **`variants`** — `{ default?, first?, even? }`, each a `HeaderFooterVariant`
  (the same `{ header, footer, style }` shape v1 already uses, factored into a
  reusable `variantShape`). `.catchall` open at every level.
- **`pageNumbering`** — `{ mode: 'continuous' | 'restartPerSpec'; startAt?:
  int }`, open via `.catchall`. `PageNumberingModeSchema` is exported for reuse.
- **`raw`** — an open sidecar `{ warnings?: string[]; … }` for captured-but-
  unmodeled header/footer OOXML, fully open so a round-trip never loses markup.

**v1 → default backward-compat.** Existing v1 payloads remain valid unchanged.
The new pure accessor `defaultVariant(config)` is the single, executable home
for the compat contract: it returns `config.variants.default` when present,
otherwise the top-level `{ header, footer, style }` fields. This keeps the
"what is the default variant" semantic in the canonical AST rather than
scattered across the render/API layers.

**Precedence when both are present.** A payload may carry *both* the v1
top-level fields and an explicit `variants.default`. OOXML has no canonical
answer; SpecR defines `variants.default` as authoritative, so a v2 caller can
deliberately override an inherited v1 layer. This is pinned as a
`// KNOWN AMBIGUITY` test (project rule for genuinely ambiguous OOXML cases).

## Consequences

- Every #208/v1 payload and its open `.catchall` extension keys still validate
  and round-trip; the existing `header_footer_configs` query/resolution surface
  is untouched (the deep-merge resolver treats configs as generic records, so
  the additive fields merge without code changes).
- Typed validation is preserved through the catchall: an invalid field `kind`
  or a bad `pageNumbering.mode`/`startAt` still fails boundary validation rather
  than being swallowed as an unknown key.
- **Deferred to downstream issues, not this schema:** whether an `even`/`first`
  variant actually renders depends on document-level OOXML flags
  (`w:evenAndOddHeaders`, `w:titlePg`) — a render/parser concern (#303/#306).
  `pageNumbering` is a stored policy here; applying it (`w:pgNumType`) is #303.
  Cross-scope precedence beyond the single-config `defaultVariant` accessor is
  the resolver's job (#304).
- No migration: `header_footer_configs.config` is JSONB; the richer shape needs
  no DDL. The schema is the contract; the column is the store.

### Compatibility caveat: reserved-key promotion (accepted)

v1's top-level `.catchall(JsonValue)` accepted *any* JSON-safe key, so a
pre-existing v1 `header_footer_config` could in principle have used `variants`,
`pageNumbering`, or `raw` as a custom extension key. v2 **promotes those three
names from open extension keys to reserved typed keys.** A legacy row that used
one of them at the top level with a value that does not conform to its new typed
shape (e.g. `{ raw: "<w:hdr/>" }`, `{ pageNumbering: { vendorPolicy: true } }`)
will now fail boundary validation.

This is an **accepted, documented migration caveat**, not a defect:

- These configs are SpecR-authored and brand-new from #208 (migration 030);
  the three names are novel to *this* feature, so real-world exposure is ~nil
  (no fixture, seed, or consumer uses them — verified during #302 review).
- The general backward-compat guarantee is **unchanged**: v1
  `{ header, footer, style }` payloads and every *non-colliding* `.catchall`
  extension key still validate and round-trip.
- The deliberately-rejected alternative is tolerant parsing (e.g.
  `union([Typed, JsonValue])`), which would let `{ pageNumbering: { mode:
  'bogus' } }` slip through and directly violate the "invalid known field kinds
  still fail boundary validation" acceptance criterion. Typed validation wins;
  the collision is documented instead. Pinned by a regression test in
  `src/ast/header-footer-schemas.test.ts`. If a real colliding legacy row ever
  surfaces, normalizing it is a data-migration concern for #304/#306.

### Update (#304)

Single-spec resolution and rendering shipped: `resolveSpecHeaderFooterContext`
(`src/db/queries/header-footer-context.ts`) resolves a spec's sole owning
project through `resolveHeaderFooterConfig` and assembles a generator-ready
context, gated on at least one configured layer (`layers.length > 0`, never
merely a non-null resolution). `buildHeaderFooterOptions`
(`src/api/generate-header-footer.ts`) stamps the current date and wires the
result into `POST /specs/{id}/generate`; the MCP `generate_docx` tool mirrors
the same resolution for parity (ADR-044). An orphan spec, an ambiguously-owned
spec, or a resolvable project with zero configured layers all fall back to the
pre-#304 output unchanged.

`generateManualHandler` (`POST /projects/{id}/generate`) and
`generateRevisionHandler` (`POST /revisions/{id}/generate`) are an explicit
scope cut, not a silent drop: they render a whole project manual or a frozen
package revision, where "the spec's sole owning project" is not the right
resolution key, so wiring them is deferred to a follow-up issue. No
package/revision-level field values (package name, revision label) are
populated on the `POST /specs/{id}/generate` path either: a bare spec id has
no unambiguous package/revision without a verified schema path, so
`HeaderFooterFieldSource` declares those fields for shape parity but they
resolve `undefined` here.

### Update (#481)

The follow-up deferred above shipped: both `generateManualHandler` and
`generateRevisionHandler` now resolve **and render** header/footer content,
closing the gap this ADR's #304 update explicitly left open.

- **Resolution.** `resolveProjectManualHeaderFooterContext`
  (`src/db/queries/header-footer-context.ts`) reuses the existing
  `buildHeaderFooterFromProject` builder behind a widened `ProjectIdentity {
  id, name }` parameter, so the whole-manual path shares its resolution logic
  with the single-spec path (#304) rather than duplicating it.
  `resolveRevisionHeaderFooterContext` resolves the client → project →
  package → revision chain for `{ revisionId }` alone; field values (project
  name, package name, revision name/label) are threaded in from the caller's
  already-fetched `RevisionManualData` rather than re-queried, so there is no
  TOCTOU window between "what was rendered" and "what the DB now says." In
  addendum mode (`baseRevisionId` supplied), resolution is always keyed on the
  **target** revision being rendered, never the comparison base. Both
  resolvers preserve the existing contract: zero configured layers anywhere
  in the chain resolves `null`/`undefined`, and the DOCX falls back to the
  pre-#481, headerless output unchanged.
- **Rendering.** `generateManual` (`src/generator/index.ts`) previously
  accepted `options.headerFooter` but discarded it — no manual-scoped
  composition ever reached a section's OOXML. It now renders the composition
  into **every TOC section's own OOXML section** via the same
  `renderOptionalHeaderFooter`/`sectionHeaderFooterOptions` helpers the
  single-spec path already used, sourcing each section's `sectionNumber`/
  `sectionTitle` only from its own `SpecTree` so per-section renders cannot
  drift or collide with a sibling's. Two behaviors worth naming explicitly,
  since both are correct but easy to assume otherwise:
  - The front-matter/cover OOXML section (project name + description, Word
    TOC field) stays deliberately headerless — confirmed by inspecting
    generated OOXML for zero `headerReference`/`footerReference` on any
    composition. `evenAndOddHeaderAndFooters` is document-scoped in
    dolanmiu/docx, so it is computed once from the first TOC section's
    render; this is not a shortcut but provably always correct, because every
    `renderOptionalHeaderFooter` call in the section loop shares the exact
    same `options.headerFooter.composition` object reference (only
    `sectionNumber`/`sectionTitle` vary per section).
  - A `variants.first` (`titlePage`/`w:titlePg`) composition applies
    **per OOXML section**, not just to the whole manual's first page — because
    every `SpecTree` opens its own section, each spec's own opening page gets
    first-page header/footer treatment. This is the intended behavior (each
    section behaves like its own mini-document for cover/first-page
    purposes), not a bug.
- **Revision-scope fallback wording.** `POST /revisions/{id}/generate`'s
  addendum cover / front-matter revision identity is unchanged by this
  update; only the *running* header/footer content is newly wired.

No new struct or Zod schema was needed: `GenerateDocxOptions` and
`ManualMeta` were already shaped to carry `headerFooter` end to end.
`openapi.yaml`'s prose for both operations is corrected in the same PR (this
file's `Update (#481)`); `src/mcp/contract-map.ts` needs no change — both
routes remain `MCP_UNEXPOSED` with an unchanged request/response shape, so
neither route's MCP-parity entry moves.
