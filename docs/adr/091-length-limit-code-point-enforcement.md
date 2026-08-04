# 091 — Length-limit enforcement in Unicode code points (supersedes ADR-088)

## Status

Accepted. Supersedes [ADR-088](088-length-limit-unit-convention.md).

## Context

JSON Schema's `maxLength` keyword is defined, unchanged from draft-04 through 2020-12:

> The length of a string instance is defined as the number of Unicode code points that
> make up the string.

ADR-088 (#626) documented — but did not fix — that this repo enforced its length bounds
in UTF-16 code units (`String.prototype.length` / Zod's `.max()`), not Unicode code
points. For any character outside the Basic Multilingual Plane (emoji, many CJK
Extension B+ characters, mathematical alphanumeric symbols), the two counts diverge by
up to 2x. ADR-088 added a prose note to every affected field's description rather than
fix enforcement, and named the reason explicitly: Option 2 (code-point enforcement) was
the correct end state under this repo's own "code conforms to the spec, not the reverse"
rule (`CLAUDE.md`, ADR-026), but it is a **behavior change** — affected fields start
accepting inputs the server rejects today — and needed its own PR with its own review.
ADR-088's Consequences section named an explicit revisit trigger for exactly this. This
issue (#642) is that PR.

A prose note does not actually fix the contract: code generators, client-side
validators, and any spec-compliant tooling read the `maxLength` **keyword**, not the
`description` text next to it. The published contract asserted something untrue about
the server's actual behavior.

### Re-derived inventory (verified against `openapi.yaml` and the generated MCP tool
### schemas at the time of this ADR, by the same mechanism the CI gates use — not by
### grep or by trusting ADR-088's numbers)

- **REST (`openapi.yaml`):** 40 raw `maxLength` declarations after YAML-alias
  expansion (`&headerFooterField` is defined once and aliased 32 times across
  header/footer region × variant), reducible to **8 distinct hand-authored sites**:
  `users.label`, `ActorLabel`, `LanguageRuleTermWrite.term`, the 4
  `StandardVerificationBody` fields, and the one `imageData` anchor. `sha256` is
  excluded (response-only, server-generated — reachability, not alphabet).
- **MCP (generated tool schemas):** **139** fields, re-verified by generating every
  registered tool's JSON Schema and counting `maxLength` occurrences exactly as
  `src/mcp/length-limit-unit-convention.test.ts` does — the same figure ADR-088
  reported, now confirmed correct by re-derivation rather than assumed. Breakdown
  unchanged from ADR-088: 5 (`ResolveUserShape.label`,
  `RecordStandardVerificationShape.*`, which re-declare their own bound rather than
  reusing the REST validators), 6 (`actorLabel` on six tools sharing
  `ActorLabelSchema`), 128 (`imageData` × header/footer region × variant × 4
  `set_*_header_footer` tools).

## Decision

**Enforce every length bound in Unicode code points, matching what `maxLength` means.**
Every site named above (and no others — this is a complete, not partial, conversion;
ADR-088's own framing already called a partial fix worse than none) now enforces the
bound it publishes.

### The helper: `codePointMax` (`src/lib/length-limit.ts`)

```ts
export function codePointMax<T extends z.ZodType<string, string>>(
  schema: T,
  n: number,
  options: CodePointMaxOptions = {}
): T {
  const described =
    options.description !== undefined ? schema.describe(options.description) : schema;
  return described
    .refine((value) => codePointLength(value, n) <= n, {
      error: options.message ?? `must be at most ${n} Unicode code points`,
    })
    .meta({ maxLength: n, [LENGTH_UNIT_META_KEY]: CODE_POINT_LENGTH_UNIT });
}
```

ADR-088 identified the exact risk of the `.refine()` + `.meta()` pattern it verified as
viable: the enforced bound (`.refine()`) and the published one (`.meta({ maxLength })`)
become two independent numbers, kept in lockstep only by convention, at ~139+ call
sites. `codePointMax` closes that gap by construction — both derive from the single
argument `n`, and every site imports a shared numeric constant
(`src/lib/label-length.ts`'s `MAX_LABEL_LENGTH`,
`src/lib/standards-verification-length.ts`'s four `MAX_*` constants,
`src/lib/image-media-type.ts`'s pre-existing `MAX_IMAGE_BASE64_LENGTH`) rather than
re-declaring a literal.

`codePointLength` counts via a short-circuiting `for...of` loop (surrogate-pair aware
through the string iterator protocol) rather than `[...value].length`, so validating the
~7 MB `imageData` field does not materialize a multi-million-element array on every
parse — it stops counting the instant the running total exceeds `n`.

### The anti-vacuity marker: `x-length-unit: unicode-code-point`

Every `codePointMax`-built field's `.meta()` also carries a vendor-extension key,
`LENGTH_UNIT_META_KEY` = `x-length-unit`, valued `CODE_POINT_LENGTH_UNIT` =
`unicode-code-point`. This directly replaces the weaker gate ADR-088 shipped
(`src/mcp/length-limit-unit-convention.test.ts` asserting a field's `.describe()`
contained a specific prose sentence) — a check any future edit could satisfy by copying
text with no enforcement behind it. The marker can only be produced by actually routing
a field through `codePointMax`, so the MCP-side sweep
(`src/mcp/length-limit-unit-convention.test.ts`) now asserts marker presence instead of
prose presence, with the same no-exemption-list posture ADR-088 established.

### The empirical finding this ADR corrects from the issue's own framing

The issue that opened this work (#642) proposed a specific trap as the highest-risk item:
that `.meta()` called before `.refine()` silently drops the published `maxLength`,
because Zod's metadata registry is keyed to a specific schema instance and `.refine()`
returns a new one. **Verified against the pinned toolchain (zod 4.4.3, MCP SDK 1.29.0)
by spike, and pinned by a test in `src/lib/length-limit.test.ts`: this does NOT
reproduce.** Both `.refine().meta()` and `.meta().refine()` publish `maxLength`
identically through `z.toJSONSchema()` and the MCP SDK's `toJsonSchemaCompat()`, and
this survives `.optional()`, `.nullish()` (nested under `anyOf`), `.exactOptional()`,
and a later `.describe(override)` in every combination tested.

The failure mode that **does** reproduce — and the one the mandated
mutation-verification test targets — is omitting `.meta()` entirely:
`z.string().refine(fn)` with no `.meta()` call generates `{"type":"string"}`, no
`maxLength` at all. `codePointMax` is kept in refine-then-meta order defensively (this
protects against a hypothetical future Zod metadata-registry change tightening
parent-chain semantics), but the shipped mutation test asserts against the real, verified
bug (missing `.meta()`), not the unverified one (wrong order). Reporting a mutation that
doesn't actually break anything would have been dishonest evidence; the honest finding —
documented here and in the PR body — is itself useful: it means every one of the ~139+
existing call sites that already used `.max(n)...describe(note)` was never at risk from
reordering, only from the UTF-16-vs-code-point counting method itself.

### `LanguageRuleTermWrite.term` stays an object-level check, not `codePointMax`

The 500-code-point bound on a language-rule literal term (`MAX_LITERAL_TERM_LENGTH`,
`src/ast/language-rule-schemas.ts`) applies only to terms where `isRegex !== true` — it
is computed inside `LanguageRulesWriteSchema`'s whole-object `.check()`, which already
distinguishes literal terms from regex-pattern terms (their own, separate,
ReDoS-safety-motivated bound in `src/lib/regex-safety.ts`). A field-level `codePointMax`
on `LanguageRuleTermSchema.term` would incorrectly apply the same ceiling to regex
terms, or be structurally inexpressible as an unconditional per-field check. Only the
counting method changed (`term.length` → `codePointLength(term, MAX_LITERAL_TERM_LENGTH)`);
this bound was never Zod-`.meta()`-published in the first place (`openapi.yaml`'s number
there is hand-authored and independently pinned by the pre-existing
`src/api/language-rules-literal-bounds-openapi.test.ts`), so it carries no
`x-length-unit` marker and is exempted from the marker assertion in the REST gate with
an inline comment explaining why.

### `sha256` remains the one true exemption

Unchanged from ADR-088: a fixed 64-character hex digest the server generates and only
ever returns, on no reachable request-body path. Reachability, not alphabet.

## Consequences

- **This is a behavior change**, exactly as ADR-088 flagged it would be. Every affected
  field now accepts inputs the server rejected before this PR — up to 2x longer, when
  measured in UTF-16 code units, for any field entirely composed of astral characters.
  Concretely: a 200-code-point `ActorLabel` made of emoji (400 UTF-16 units) is now
  accepted; before this PR it was rejected 422. Seven of the eight sites are free-text
  descriptive metadata (labels, titles, notes, a URL, a version string); the eighth,
  `imageData`, is a ~7 MB base64 cap effectively unreachable from this direction in
  practice (reaching the divergence needs ~3.5 million astral characters, well past the
  JSON body-size limit).
- `UTF16_LENGTH_LIMIT_NOTE` (`src/lib/length-limit-note.ts`) and the note-presence gates
  it powered are deleted. Every `openapi.yaml` description that referenced the
  divergence is rewritten to state the bound is in Unicode code points (or simply drops
  the now-redundant sentence) — a stale claim that the server still diverges from the
  published contract would be actively misleading now that it doesn't.
- `src/api/length-limit-unit-convention.test.ts` and
  `src/mcp/length-limit-unit-convention.test.ts` are rewritten: REST parity now asserts
  spec `maxLength` === an **imported TS constant** === the Zod-enforced boundary
  (probed with a non-BMP character) === the `x-length-unit` marker on the Zod field's
  own generated schema — closing the specific vacuous-gate class flagged during this
  change (an earlier revision of the REST gate compared `openapi.yaml` against a
  hardcoded literal, so a Zod bound could drift 200→199 with nothing to catch it).
- **Revisit trigger:** none outstanding. The interim step ADR-088 named is complete for
  every site in its inventory.

## Related

- [ADR-088](088-length-limit-unit-convention.md) — the interim "accept and document"
  decision this ADR supersedes; its Context/Decision/Consequences remain the historical
  record of the original inventory and the reasoning for deferring conversion.
- [ADR-026](026-openapi-contract-testing.md) — `openapi.yaml` as the hand-authored,
  CI-enforced authoritative contract; the standing rule ("code conforms to the spec")
  this decision now actually satisfies for length bounds.
- [ADR-044](044-mcp-contract-testing.md) — MCP tool-surface parity with the REST
  contract, preserved here: every converted field enforces and publishes identically on
  both surfaces.
