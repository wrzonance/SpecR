# 088 — Length-limit unit convention: UTF-16 code units, documented not converted

## Status

Accepted

## Context

The repo consistently pairs a Zod `.max(n)` / `.check(z.maxLength(n))` on a request-body
field with an `openapi.yaml` `maxLength: n` on the same schema field. Those two `n`s do
not measure the same thing:

- **Zod's `.max()`/`.check(z.maxLength(n))`** delegates to JavaScript
  `String.prototype.length` — **UTF-16 code units**.
- **JSON Schema's `maxLength` keyword** is defined (draft 2020-12 §6.3.2, unchanged since
  draft-04) in **Unicode code points**.

For any character outside the Basic Multilingual Plane (emoji, many CJK Extension B+
characters, mathematical alphanumeric symbols), one code point is two UTF-16 units, so
the documented limit and the enforced limit diverge by up to 2x:

```
emoji count (code points):        251
JS .length (UTF-16 units):        502
Zod .max(500) would:              REJECT
JSON Schema maxLength: 500 would: ACCEPT
```

A caller sending 251 emoji into a 500-`maxLength` field hits a 422 that `openapi.yaml`
says should have been accepted. The contract is wrong in the **client-visible**
direction: the spec is more permissive than the server. Filed as #626, itself carved out
of #541 (Codex adversarial review on PR #620), because the divergence is a pre-existing
repo-wide convention — 8 of the 9 current sites predate #620's `LanguageRuleTermWrite`.

### Inventory (verified against `openapi.yaml` at the time of this ADR)

| Site | `maxLength` | Zod check | In scope? |
|---|---|---|---|
| `users.label` (resolve-user request body) | 200 | `ResolveUserBody.label`, `src/api/users.ts` | yes |
| `ActorLabel` (shared field schema) | 200 | `ActorLabelSchema`, `src/ast/actor-schemas.ts` | yes |
| `LanguageRuleTermWrite.term` | 500 | `MAX_LITERAL_TERM_LENGTH`, `src/ast/language-rule-schemas.ts` | yes |
| `StandardVerificationBody.currentVersion` | 200 | `VerificationBodySchema.currentVersion`, `src/api/standards.ts` | yes |
| `StandardVerificationBody.sourceUrl` | 2000 | `VerificationBodySchema.sourceUrl` | yes |
| `StandardVerificationBody.title` | 500 | `VerificationBodySchema.title` | yes |
| `StandardVerificationBody.notes` | 5000 | `VerificationBodySchema.notes` | yes |
| `originMeta.sha256` | 64 | fixed-length hex digest | **no** — ASCII-only |
| header/footer `imageData` | 6990508 | `MAX_IMAGE_BASE64_LENGTH`, base64 byte cap | **no** — ASCII-only |

`sha256` (a fixed 64-character hex digest) and `imageData` (base64, RFC 4648 alphabet)
are both restricted to an ASCII-only alphabet. Every character in both alphabets is a
single UTF-16 unit *and* a single Unicode code point, so the two counting methods are
always numerically identical at those two sites — there is no divergence for either
direction to fix, so they are excluded from this decision rather than silently skipped.
### The MCP surface is in scope too

`openapi.yaml` is not the only place this repo publishes these bounds. Each MCP tool's
JSON Schema is **generated** from its Zod shape, and the SDK copies a declarative
`.max(n)` / `z.maxLength(n)` straight through as `maxLength: n`. An MCP client therefore
reads the same code-point-defined keyword the REST contract does — mechanically, with no
prose to consult unless the field's `.describe()` carries it. Enumerated by generating
every registered tool's schema (not by grep), the MCP surface publishes **139**
`maxLength` fields:

| MCP fields | Origin | Disposition |
|---|---|---|
| 5 | `ResolveUserShape.label`; `RecordStandardVerificationShape.{currentVersion,sourceUrl,title,notes}` | in scope — note added |
| 6 | `actorLabel` on `update_paragraph`, `insert_paragraph`, `remove_paragraph`, `accept_comment_as_note`, `apply_merge`, `create_checkpoint` | in scope — note added |
| 128 | `imageData` (every header/footer region × variant on 4 `set_*_header_footer` tools) | excluded — ASCII-only base64 |

The first group does **not** reuse the REST validators — `ResolveUserShape` and
`RecordStandardVerificationShape` each re-declare their own `.max(n)` literals, so they
inherit nothing and were annotated individually. The second group *is* genuine reuse of
the shared `ActorLabelSchema` (`src/ast/actor-schemas.ts`), so the note lives on that
schema and propagates to all six tools; the two sites that override with their own
`.describe()` (`MergeFieldsShape.actorLabel`, `AcceptCommentShape.actorLabel`) append it
explicitly. `LanguageRuleTermWrite.term` has no MCP twin that publishes a bound.

Because the MCP inventory is generated rather than hand-authored, a future tool can
publish a fresh `maxLength` with no contract file edited. That is pinned as an invariant
rather than an inventory: `src/mcp/length-limit-unit-convention.test.ts` walks every
registered tool's generated schema and fails on any `maxLength` that carries neither the
note nor a justified ASCII-only exemption.

## Decision

**Option 1 — accept and document.** Every in-scope `openapi.yaml` field description
states the limit is counted in UTF-16 code units, matching the Zod behavior that
actually enforces it. No validation behavior changes.

Three options were on the table; the other two are rejected below.

### Option 2 (rejected): make Zod count code points

Validate with `[...str].length` (or `Intl.Segmenter` for grapheme clusters) so the
server enforces what JSON Schema's `maxLength` keyword means. This is the option most
consistent with this repo's own standing rule that `openapi.yaml` is the authoritative
contract and code conforms to the spec, not the reverse (`CLAUDE.md`) — and was the
leading candidate on that basis alone.

It is rejected on a verified technical finding, not just risk-aversion. The MCP tool
surface generates each registered tool's JSON Schema from the same Zod validators via
`node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js`:

```js
export function toJsonSchemaCompat(schema, opts) {
    if (isZ4Schema(schema)) {
        // v4 branch — use Mini's built-in toJSONSchema
        return z4mini.toJSONSchema(schema, { ... });
    }
    ...
}
```

For Zod v4 (this repo's `zod` major), that delegates to `zod/v4-mini`'s own
`toJSONSchema()`. Its string processor
(`node_modules/zod/v4/core/json-schema-processors.js`) reads the field's `maxLength`
from `schema._zod.bag.maximum` — a slot populated *only* by Zod's own declarative
checks (`.max()`, `z.maxLength()`). A hand-written code-point-aware check
(`.check((val) => [...val].length <= n)` or an `Intl.Segmenter`-based refinement) is not
declarative — Zod cannot introspect an arbitrary function body — so it never writes to
`bag.maximum`. The generated MCP JSON Schema for that field would simply carry no
`maxLength` at all: not a parity mismatch CI can catch by comparing numbers, but a
silent *disappearance* of the bound from the MCP tool's declared contract, breaking the
REST↔MCP parity ADR-044 exists to guarantee. (Zod v4's `toJSONSchema()` separately
throws on truly unrepresentable primitive types — e.g. `bigint`, `symbol` — confirmed
via `node_modules/zod/v4/core/to-json-schema.js`'s `unrepresentable: "throw"` default;
a custom string check doesn't hit that path, it is simply invisible to the bag-based
string processor.)

Making Option 2 safe would require *retaining* a declarative `.max()` purely for schema
generation (measured in UTF-16 units, same as today) *alongside* a second, separate
code-point-aware check purely for enforcement — two checks doing two different jobs on
the same field, more surface than either the repeal or the accept-and-document option,
landing in exactly the MCP schema-generation path a sibling workstream
(`test/issue-627`, `src/mcp/contract-map.ts` and friends) is concurrently editing. That
is a real, scoped follow-up, not a reason to abandon the "code conforms to the spec"
principle — see Consequences below for its revisit trigger.

### Option 3 (rejected): leave as-is, no documentation

The issue explicitly frames a partial fix — or a silent no-op — as worse than no
change, because the value of this decision is a single, verifiable convention applied
uniformly. Closing without at least documenting the deviation would leave the
`openapi.yaml` contract wrong in the client-visible direction with no signal to a
consumer, and wastes the inventory work this issue already did. Rejected.

## Consequences

- All 7 in-scope `openapi.yaml` field descriptions gain a standard sentence
  (`src/lib/length-limit-note.ts`'s `UTF16_LENGTH_LIMIT_NOTE`) stating the limit is
  counted in UTF-16 code units, referencing this ADR. A drift-guard test
  (`src/api/length-limit-unit-convention.test.ts`) pins the exact wording so the prose
  and the constant cannot silently diverge, and pins each MCP twin's bound against its
  REST counterpart so the two surfaces cannot drift apart numerically.
- All 11 in-scope MCP tool fields carry the same sentence in their `.describe()`, so the
  generated tool schemas document the divergence as fully as `openapi.yaml` does. The
  MCP side is gated by an invariant sweep rather than a site list
  (`src/mcp/length-limit-unit-convention.test.ts`), because those schemas are generated:
  a new tool publishing a bare `maxLength` fails by default instead of slipping past an
  enumeration.
- No enforced behavior changes anywhere. The blast radius this ADR accepts, unchanged
  from before: a caller writing 250+ astral characters (emoji, rare CJK, math
  alphanumerics) into one of these descriptive fields gets a 422 that a strictly
  spec-compliant client-side validator would not have predicted. All 7 fields are
  free-text descriptive metadata (labels, titles, notes, a URL, a version string) —
  none are structural/identifier fields where a silent truncation or off-by-one would
  corrupt data.
- `sha256` and `imageData` are unaffected either way (ASCII-only alphabets) and are
  called out explicitly in `openapi.yaml` and in this ADR rather than left to look like
  an unexplained omission from the inventory.
- **Revisit trigger for Option 2:** if a real client is shown to materially rely on
  code-point counting (e.g. a generated SDK's own client-side validator rejecting valid
  server input), *and* a follow-up spike lands a safe dual-check pattern (declarative
  `.max()` retained for MCP schema generation, separate code-point check for
  enforcement) that does not regress ADR-044 parity, Option 2 becomes viable as its own
  scoped PR — not folded into this one.

## Related

- [ADR-026](026-openapi-contract-testing.md) — `openapi.yaml` as the hand-authored,
  CI-enforced authoritative contract this decision keeps honest.
- [ADR-044](044-mcp-contract-testing.md) — MCP tool-surface parity with the REST
  contract; the reason Option 2's schema-generation gap is disqualifying rather than a
  minor wrinkle.
