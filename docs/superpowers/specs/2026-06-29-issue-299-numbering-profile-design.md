# #299 — Structural numbering profile at formatting ingress

**Status:** Approved (brainstorm 2026-06-29)
**Issue:** [#299](https://github.com/wrzonance/SpecR/issues/299) — `feat(onboarding): numbering/hierarchy profile at formatting ingress`
**Split off:** [#316](https://github.com/wrzonance/SpecR/issues/316) — Part B (non-conforming-part-numbering `ParseWarning`) is now its own issue and is **not** in this scope.

## Why

The 5-signal inference engine assumes the CSI integer-PART model (`PART 1`…`PART 5`,
no `PART 1.0`/`PART 1.1`, max 5 parts) and infers a document's numbering/hierarchy
per file. For a genuinely non-standard source, "guess per document" is the wrong
posture: the operator should be able to **declare** the source's structural
numbering scheme once at ingress and have it applied **deterministically**, the
same way #125 lets them declare the *visual* style. This is the *structural*
sibling of #125's *visual* style template — same scoped-profile resolution,
different payload.

Indentation (Signal 5) is explicitly **out of scope** — paragraph-indentation
thresholds remain the engine's job and are never an operator-set value.

## Scope (this issue)

A saveable, editable **structural-numbering profile**: its data model, the
ingress snapshot→edit→assign→apply loop, deterministic override of the inference
engine when a profile is assigned, and the REST surface. No onboarding UI (Phase-5
wizard #141/#144), no MCP write tools, no auto-suggestion of a profile.

## Decisions (settled in brainstorm)

1. **Dedicated `numbering_profiles` table** — mirror `editing_conventions`
   (#137) / `style_templates` (#125), not folded into either. One table per
   scoped concern is the established factoring, and it keeps this work unblocked
   from #125 (which isn't built yet).
2. **Library-scoped + per-spec assignment FK + built-in CSI default.** The
   firm→client→project→package→issuance chain in the issue body is aspirational
   (those tiers don't exist yet); today's reality is library scope + a built-in
   default row, exactly as `editing_conventions` and `style_templates` work.
3. **Deterministic override** of the numId→tier and style→`numPr` mapping
   (signals 1–2) when a profile is assigned. Doc-order/text-regex/indentation
   (signals 3–5) still run for per-paragraph classification. Disagreement between
   the profile and what inference *would* have said is written to
   `paragraphs.conflicts` (persisted, never dropped).
4. **Parser stays pure** — the inference entry point gains an *optional*
   `numberingProfile` parameter; the API/ingress layer resolves
   `spec.numbering_profile_id ?? built-in CSI default` and injects it. Same
   "resolve outside, inject in" contract #304 uses for header/footer.
5. **Build the snapshot-extractor now** — without it the profile must be
   hand-authored, which makes the feature much weaker. The extractor is what makes
   the declared scheme *editable from the real source*.

## Data model

### Table `numbering_profiles` (migration, reversible)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `library_id` | uuid FK → `libraries` | **NULL = built-in default** |
| `name` | text NOT NULL | non-empty CHECK (house style) |
| `rules` | jsonb NOT NULL DEFAULT `'{}'` | validated by `NumberingProfileSchema` |
| `created_at` / `updated_at` | timestamptz NOT NULL | `now()` |

- **Built-in-default singleton**: unique index on `((library_id IS NULL)) WHERE
  library_id IS NULL`, seeded with one `'CSI Default'` row — identical pattern to
  `editing_conventions_builtin_singleton`. The CSI default encodes the integer-PART,
  max-5 model and the standard PART/Article/Paragraph/Subparagraph tier ladder.
- The seeded default literal is **frozen in the migration** (never imported from
  `src/` runtime), per the project's migration-snapshot rule.

### Column `specs.numbering_profile_id` (same migration or paired)

- Nullable uuid FK → `numbering_profiles`, **ON DELETE RESTRICT** (a referenced
  profile cannot be deleted; the 409 is enforced in the delete path), indexed.
  Exact parallel of `specs.style_template_id` (#138, migration 027). NULL = "no
  profile assigned" → resolution falls back to the built-in CSI default.

### `NumberingProfileSchema` (Zod, `src/ast/`)

Open schema (ADR-021 pattern: typed known keys + `.catchall(JsonValue)` to
preserve unknown keys and round-trip them). It is the **externalized, editable
form** of what the engine computes today — exact field names are derived at
implementation time from `src/parser/docx/numbering.ts` (the numId→ilvl→label
map) and `inference.ts`/`heuristics.ts` (the style→`numPr` associations). The
three components the issue names:

- **`numbering`** — the multi-level list scheme: `numId → [{ ilvl, tier,
  labelTemplate, format }]`.
- **`styleLadder`** — paragraph-style ↔ numbering-level associations:
  `[{ styleId, numId, ilvl, tier }]`.
- **`tiers`** — per-tier shape and bounds, e.g. `part: { numberStyle: 'integer',
  maxCount: 5 }`. The `part` tier rejects non-integer / >5 at the schema boundary.

Lives in `src/ast/` because `ast/` is the foundational layer (`db/` and `parser/`
depend on it, never the reverse) — same home as `StyleNodeType` / the H/F schemas.

## Ingress flow: snapshot → parameterize → save → assign → apply

1. **Snapshot** (new, pure function): given a parsed DOCX's numbering/style data,
   emit a `NumberingProfile` draft = the externalized form of what the engine
   inferred. This is the operator's editable starting point (it is *not* persisted
   automatically; it is a read-model the operator can save).
2. **Edit + save**: the operator (REST now; wizard #141/#144 later) edits the
   draft and `POST`s it as a named profile in its library.
3. **Assign**: `PUT /specs/:id/numbering-profile { profileId }` sets
   `specs.numbering_profile_id`.
4. **Apply**: structure is re-resolved with the profile authoritative (see below).

A spec with **no** assigned profile resolves to the built-in CSI default, which is
behaviourally identical to today's engine — so an un-onboarded spec is unchanged.

## Inference integration (deterministic override, pure parser)

- The inference entry point (`src/parser/docx/inference.ts`, surfaced through the
  parser barrel) gains an **optional** `numberingProfile?: NumberingProfile`
  parameter. The parser does **not** read the DB.
- The **API/ingress layer** resolves the effective profile
  (`spec.numbering_profile_id ?? built-in CSI default`) and injects it into the
  parse/re-parse call — the #304 "generator/engine stays pure, caller resolves
  context" contract.
- When a profile is present, it is **authoritative** for the numId→tier and
  style→`numPr` mapping. Signals 3–5 (document order, text regex, indentation)
  still run for per-paragraph classification.

> **Implementation note (#319):** today the profile's authority over the numId→tier
> mapping flows through `ilvl` + `articleIlvl` — classification derives the node type
> from those (`ilvlToNodeType`). The explicit `tier` field on `styleLadder`/`numbering`
> is *written by the extractor* (`tierForIlvl`) and *not read on apply*, so it is a
> derived label: editing `tier` without a matching `ilvl` is a silent no-op. Making
> `tier` independently authoritative (or rejecting an inconsistent `tier`/`ilvl` pair)
> is deferred to #319; the current behavior is pinned by a KNOWN AMBIGUITY test in
> `numbering-profile-apply.test.ts`.
- Where the profile disagrees with what inference *would* have produced for a
  paragraph, that disagreement is written to `paragraphs.conflicts` (JSONB,
  existing channel) and surfaces as `meta.conflicts` — persisted, never dropped.
- **Invariant (hard):** absent a profile (or with the built-in CSI default), the
  produced AST is **byte-for-byte today's behavior**. This is the backward-compat
  contract and the primary regression guard.

## API surface (must update `openapi.yaml` in the same PR)

Mirror the existing style-source / template endpoints and the
`ApiResponse<T>` envelope:

- `GET  /libraries/:id/numbering-profiles` — list a library's profiles (+ built-in default).
- `POST /libraries/:id/numbering-profiles` — create `{ name, rules }`.
- `GET  /numbering-profiles/:id` — fetch one.
- `PATCH /numbering-profiles/:id` — edit `{ name?, rules? }`.
- `DELETE /numbering-profiles/:id` — 409 if referenced by any spec (RESTRICT).
- `PUT  /specs/:id/numbering-profile { profileId }` / `DELETE /specs/:id/numbering-profile` — assign / unassign (mirrors `setSpecStyleSource`).
- `GET  /specs/:id/numbering-profile/snapshot` — the extracted draft (flow step 1).

Boundary validation with Zod; errors via the module error classes
(`ParserError`/`GeneratorError` as appropriate) mapped by the API error middleware
(422 on validation, 409 on RESTRICT conflict).

Read-only MCP tool `get_numbering_profile` is **optional** (nice-to-have, same
read-only posture as other MCP tools); MCP write tools are out of scope.

## Testing / invariants

Tests pin invariants at module boundaries, not internals:

- **No-profile parse == current AST** — golden snapshot on ARCAT (cleanest) **and**
  CPI (the ilvl-offset case) fixtures, unchanged. The core regression guard.
- A declared profile on a deliberately non-standard fixture yields the operator's
  tiers deterministically (the override actually overrides).
- Profile/inference disagreement surfaces in `meta.conflicts`, not silently.
- `NumberingProfileSchema` rejects a `part` tier with >5 or non-integer at the
  boundary; round-trips unknown keys.
- Built-in CSI default resolves when a spec has no assignment.
- `ON DELETE RESTRICT`: deleting a referenced profile → 409 (integration).
- Any genuinely ambiguous OOXML mapping documented with a `// KNOWN AMBIGUITY:`
  test per the project rule.

## Deliberately deferred (YAGNI)

- Firm/client/project/package/issuance scope tiers (don't exist yet — library +
  built-in default only today; the per-spec FK is forward-compatible with
  `spec.X ?? project.X ?? default`).
- MCP write tools for profiles.
- Onboarding UI (Phase-5 wizard #141/#144).
- Auto-suggesting/detecting a profile from a recognized scheme.
- Re-rendering deviant specs through a profile (#146).

## References

- #316 — Part B (non-conforming-part-numbering warning), split out of this issue.
- #125 / ADR-021 — visual style template; the sibling subsystem sharing scoped resolution.
- #137 / ADR-022 (`editing_conventions`) — the scoped-profile precedent this mirrors.
- #138 / migration 027 (`specs.style_template_id`) — the per-spec assignment-FK precedent.
- #304 — the "engine stays pure, caller resolves + injects context" contract reused here.
- #145 — conformance audit (downstream reporting once masters exist).
- ADR-015 — scoped hierarchy / custody (the eventual full scope chain).
