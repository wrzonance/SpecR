# ADR-093: INV-6 driven cases assert exact-key-match, not schema conformance

## Status

Accepted

## Context

`delete_package` (MCP) returned `{ deleted: true, packageId }`, while the
mapped REST route (`DELETE /packages/{id}`, `src/api/packages.ts`) and
`openapi.yaml`'s `delete /packages/{id}` 200 schema both document only
`{ packageId }`. `openapi.yaml` is the authoritative API contract
(ADR-026) and the MCP tool surface is contract-bound to it (ADR-044) — the
extra `deleted` key was an undocumented, REST-less divergence of exactly the
class the #550 parity audit exists to eliminate.

It was invisible to INV-6 (#549), the gate whose entire purpose is
response-shape validation for write-mapped tools. `assertResponse` compiles
each op's documented `200` response schema with ajv and validates the driven
payload against it — but none of `openapi.yaml`'s response schemas set
`additionalProperties`/`unevaluatedProperties: false`, so ajv (`strict:
false`) accepts any extra key a schema doesn't mention. The gate proved the
documented fields were present and correctly typed; it could not prove their
absence of extras. PR #635 (merged, `44806f43`) promoted `delete_package`
alongside `delete_spec`, `delete_project`, and `submittal_register` out of
`INV6_WRITE_PENDING` and left a scope note in
`contract-write-response.integration.test.ts` pointing at this issue rather
than fixing it inline — deliberately test-only scope at the time.

Fixing only `handleDeletePackage` (dropping `deleted`) would ship a fix
whose gate still cannot catch a recurrence, or a same-shaped divergence on
any other driven op. The gate itself needed to close, not just the bug.

An audit of the other 7 `INV6_DRIVEN` ops (`create_project`, `create_client`,
`resolve_user`, `create_client_library`, `submittal_register`, `delete_spec`,
`delete_project`) confirmed each is `ok(await dbFn())` or a direct
destructure of `dbFn()`'s fields — correct by construction, no hand-added
extra keys. `delete_package` was the sole outlier among the 8.

## Decision

### Fix: `handleDeletePackage` returns `{ packageId }` (Option 1 of #640, not Option 2)

`src/mcp/package-handlers.ts`'s success path drops `deleted: true`. This is
an **observable MCP tool response change** — a consumer of `delete_package`
reading `.deleted` off the result breaks. Accepted because `delete_package`
is a contract-bound MCP surface (ADR-044): its documented shape is
`{ packageId }`, a `200` already signals success, and the field carried no
REST counterpart to begin with — it was never part of the contract.
Option 2 (documenting `deleted` in `openapi.yaml` and adding it to REST too)
was rejected: it would grow the contract to accommodate an accidental extra
key rather than removing the accident, and the issue's own suggested
direction states the preference explicitly.

### Gate: INV-6's 8 driven cases move from schema-conformance to exact-key-match

Added `assertResponseExact` (`src/test-utils/contract/validate-response.ts`),
used only by `contract-write-response.integration.test.ts`'s
`it.each(INV6_DRIVEN)` call site — INV-5 (read-mapped tools, a much larger
and separately-audited universe) is unchanged and still uses `assertResponse`.
`assertResponseExact`:

- Shares op/status/schema lookup with `assertResponse` via an extracted
  `resolveResponseSchema` helper (no behavior change to `assertResponse` or
  INV-5's call site).
- `structuredClone`s the resolved response schema (cycle-safe for the
  self-referential shapes some dereferenced components can have) and walks
  it (`src/test-utils/contract/unevaluated-properties.ts`), injecting
  `unevaluatedProperties: false` at every node that itself evaluates
  properties — **except** it never marks a branch reached through an
  **in-place applicator**, only the node that owns the keyword (see the
  applicator rule below).
- Compiles a **fresh, uncached** ajv validator against the augmented clone —
  never through `getValidator`'s shared `WeakMap`, which INV-5's
  `assertResponse` call site also reads and would be corrupted by an
  in-place schema mutation or a cached augmented validator leaking across
  runs.

### The applicator rule: mark the owner, never an in-place branch

This exception is load-bearing, not cosmetic, and was found by implementing
the naive version first. `unevaluatedProperties` is scoped to the annotations
produced by the schema object that **declares** it — a subschema never sees
annotations produced by its parent or its siblings. That single rule splits
every subschema-bearing keyword in two:

- **In-place applicators** (`allOf`, `oneOf`, `anyOf`, `if`/`then`/`else`,
  `dependentSchemas`) apply to the **same** instance location as their
  parent. Marking such a branch is a bug: evaluated standalone against the
  whole instance, it is blind to keys its parent and sibling branches
  evaluate. Every one of these 8 ops' response schemas is
  `allOf: [SuccessResponse, { properties: { data: ... } }]` — marking each
  branch made the `{ data: ... }` branch reject `success` as "unevaluated,"
  producing 7 false-positive failures even though every payload was correct.
  Only the node that **owns** the keyword may be marked; there,
  `unevaluatedProperties` correctly unions the annotations of every
  successful in-place applicator with the owner's own.
- **Child applicators** (`properties`, `patternProperties`, schema-valued
  `additionalProperties`/`unevaluatedProperties`, `items`, `prefixItems`,
  `contains`) apply to a **different** instance location — a property value
  or an array element — so each is evaluated standalone and marked like any
  top-level schema.

An adversarial review of the first implementation (Codex `gpt-5.6-sol`,
xhigh) corrected two errors in this classification that the original
`allOf`-only exception left standing:

1. **`oneOf`/`anyOf` were treated as child applicators** ("exactly one branch
   applies, so each is evaluated standalone"). That reasoning is wrong twice
   over: it says nothing about the parent's **sibling** keywords, so a schema
   with both `properties` and `oneOf` false-positives exactly like the
   `allOf` envelope did; and `anyOf` combines the annotations of **every**
   successful branch, so the "one branch" premise does not hold at all.
   Marking the owner instead is both correct and no less strict — 22 nodes in
   `openapi.yaml`'s 2xx response schemas are `oneOf`/`anyOf` with no sibling
   `properties` and no `allOf`, and those are precisely the nodes that would
   have gone **unmarked and vacuous** had the branches simply stopped being
   marked without extending the owner-marking rule to cover them.
2. **Objects reachable only through `patternProperties`, schema-valued
   `additionalProperties`, `prefixItems`, `contains`, `if`/`then`/`else`, or
   `dependentSchemas` were never walked at all**, so every key inside them
   was undocumented-but-accepted — a vacuous gate at exactly the nesting
   depth this ADR cares about. Two such shapes are already live in
   `openapi.yaml`'s 2xx responses (one schema-valued `additionalProperties`,
   one `prefixItems`).

`not` is deliberately excluded: it succeeds precisely when its subschema
fails, its annotations are discarded, and injecting a marker inside it could
flip the branch's result.

The classification is verified rather than asserted: all 132 compilable 2xx
JSON response schemas in `openapi.yaml` reject an undocumented top-level key,
and all 8 `INV6_DRIVEN` ops reject an extra key spliced onto their real
driven payload — not just `delete_package`.

### Known limitation: recursive `SpecNode` responses cannot be compiled

Six ops (`get /specs/{id}`, `get /revisions/{id}`, and the four
`/specs/{id}/paragraphs*` writes) resolve to a self-referential `SpecNode`
tree that ajv cannot compile at all — `RangeError: Maximum call stack size
exceeded`. This is **pre-existing and not specific to exact-key-match**:
plain `ajv.compile()` on the dereferenced schema fails identically, so
`assertResponse` has always thrown for those ops too. It fails **loud**, so
it is not a vacuity hole; none of those ops is currently driven by INV-5 or
INV-6. Fixing it means keeping `$ref` recursion for the validation path
(bundling rather than dereferencing) — a change to the shared contract
harness affecting INV-5 equally, out of scope here.

### Regression coverage

A permanent test (`contract-write-response.integration.test.ts`, "INV-6
regression (#640)") drives a real `delete_package` success payload, splices
`deleted: true` back onto it, and asserts `assertResponseExact` rejects it —
the durable form of the issue's mandated mutation-verification, not just a
one-off manual check pasted into the PR body.

## Consequences

- `delete_package`'s MCP tool response shape changes: `deleted` is gone.
  Documented as a breaking change in the PR body per ADR-044's contract-bound
  posture — acceptable because the field was never contractual.
- INV-6's 8 driven cases now fail on ANY undocumented extra key on those
  ops, not just missing/mistyped documented fields — closing the vacuous-gate
  hole this issue exists to fix. A future accidental extra key on any of
  these 8 ops fails CI instead of merging silently.
- INV-5 (read-mapped tools) is unchanged — this ADR scopes the tightening to
  INV-6's driven cases only. Applying exact-key-match to INV-5's much larger,
  separately-maintained universe is a distinct audit or follow-up, not part
  of this change.
- The stale scope note in `contract-write-response.integration.test.ts`
  pointing at #640 is removed — the bug it described is fixed and the gate
  now self-enforces, so no residual pointer is needed.
- No `openapi.yaml` change: REST and the spec already agreed on
  `{ packageId }`; only the MCP handler moved to match.
- `resolveResponseSchema` now also fails loud when an operation documents an
  `application/json` response carrying **no schema**. `successJsonOps` keys
  off the media type, not the schema, so such an op counts as in-scope JSON
  while validating nothing — the same vacuity class as the undocumented-status
  guard beside it. No response in today's `openapi.yaml` has that shape, so
  the guard is pinned against a synthetic doc rather than left untested.
- The walker lives in its own module
  (`src/test-utils/contract/unevaluated-properties.ts`) because
  `validate-response.ts` was at the repo's 400-line cap and the applicator
  rules above carry more commentary than the rest of that module.
