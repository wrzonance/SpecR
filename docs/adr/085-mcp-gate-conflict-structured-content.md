# ADR-085: structured content for merge/paragraph edit-gate conflicts

## Status

Accepted

## Context

ADR-083 (#569) gave `toolError` an optional `structuredContent` channel and
converted `lock_spec` as its first consumer, explicitly deferring two other
409-equivalent consumers of the edit-gate / version-conflict error classes
(`StaleVersionError`, `SpecWriteForbiddenError` — `src/api/edit-gate-response.ts`):

- `src/mcp/merge-handlers.ts` (`mergeToolError`)
- `src/mcp/paragraph-handlers.ts` (`gateToolError`)

Both flattened either error class into prose only. An agent that lost a
concurrent edit had to regex a sentence to learn the current version it
should re-read against, where the equivalent REST caller reads a field off
the 409 body.

Unlike `lock_spec`'s `holder`/`expiresAt` pair, these two error classes do
not share a uniform payload shape, so the field set has to be derived per
class from what REST actually returns — not invented by symmetry with
`lock_spec`.

## Decision

Read directly from `src/api/edit-gate-response.ts` (`gateErrorResponse`),
the single source both REST and MCP write paths key off of:

```ts
if (err instanceof StaleVersionError) {
  return {
    status: 409,
    body: { success: false, error: err.message, currentVersion: err.currentVersion },
  };
}
if (err instanceof SpecWriteForbiddenError) {
  return { status: 409, body: { success: false, error: err.message } };
}
```

**`stale_version` → `structuredContent: { currentVersion: err.currentVersion }`.**
This mirrors both `StaleVersionError`'s own field and REST's 409 body
field-for-field:

```ts
if (err instanceof StaleVersionError) {
  return toolError(
    `stale version — current contentVersion is ${err.currentVersion}; re-run get_spec_diff and retry`,
    { structuredContent: { currentVersion: err.currentVersion } }
  );
}
```

**`write_forbidden` → no `structuredContent` key at all.** REST's 409 body
for `SpecWriteForbiddenError` is `{ success, error }` with nothing beyond the
message, and the error class itself carries no separate reason field — both
throw sites (`src/db/queries/edit-gate.ts`: the archived-spec case and the
upstream-lock case) bake the reason into `.message` text only. There is no
REST field to mirror, so the omission is the correct parity outcome, not an
oversight:

```ts
// REST's 409 body for this class carries nothing beyond `error` — no
// structuredContent to mirror, so the omission here is deliberate, not unfinished.
if (err instanceof SpecWriteForbiddenError) return toolError(err.message);
```

This is applied identically in both `mergeToolError` and `gateToolError` —
the two functions stay independent (see Consequences) rather than being
merged into a shared helper, because their prose wording differs
(`"re-run get_spec_diff and retry"` vs `"refetch and retry"`) and unifying
them would need a caller-supplied formatter parameter to cover that, trading
two small readable functions for one parameterized one.

`SpecNotFoundError` and the merge-only branches
(`InvalidAcceptedChangeError`, `MergeError`) are unaffected: REST returns no
structured field for a 404 either, and neither class is in scope here.

## Consequences

- The precedent for future MCP error-to-`structuredContent` conversions is:
  check the REST 409/4xx body first, mirror only the fields actually present
  there, and let a class with nothing extra in REST carry nothing extra in
  MCP. Symmetry with a previously-converted tool (e.g. `lock_spec`'s two
  fields) is not itself a reason to invent a field neither surface has.
- `stale_version` failures from `apply_merge`, `update_paragraph`,
  `insert_paragraph`, `remove_paragraph`, and `accept_comment_as_note` now
  let an agent read `currentVersion` directly instead of parsing prose,
  matching what a REST caller already gets from the same conflict.
- `write_forbidden` failures remain prose-only by design on both surfaces;
  if `SpecWriteForbiddenError` or its REST mapping ever gains a structured
  reason field, this ADR's own precedent obligates updating both
  `mergeToolError` and `gateToolError` to mirror it, not just one.
