# ADR-081: MCP tool-error structured content, scope 404 reuse, and seed-description accuracy

## Status

Accepted

## Context

Issue #569 (workstream C of #550's REST↔MCP error-fidelity audit) found three
divergences where the MCP surface tells an agent _less_ than REST tells an
HTTP client about the same failure or capability, even though both sit on
the same underlying operation:

1. **Header/footer scope 404s degrade to "internal error."**
   `headerFooterToolError` (`src/mcp/header-footer-handlers.ts`) only
   recognized `HeaderFooterValidationError` and `HeaderFooterScopeError`.
   A foreign-key violation on a nonexistent project/package/revision id
   (pg `23503`) fell through to `internalError()` — a generic
   "Internal error — set_package_header_footer failed" that an agent cannot
   distinguish from a real server fault, gets logged at error level, and
   invites a pointless retry. REST's `mapWriteError`
   (`src/api/header-footer.ts`) already classifies the same `23503` into a
   clean 404 "referenced scope not found."

2. **`lock_spec` folds a 409-equivalent's structured fields into prose.**
   `toolError(text: string)` (`src/mcp/handlers.ts`) had no channel for
   machine-readable data. On lock contention, `handleLockSpec`
   (`src/mcp/lock-handlers.ts`) could only return
   `"spec is locked by ${holder} until ${expiresAt}"` as text. REST's
   `PUT /specs/:id/lock` 409 response returns `holder` and `expiresAt` as
   real fields (`src/api/locks.ts`), which a client can read directly to
   schedule a retry. An MCP client has to regex a sentence.

3. **`set_required_sections`'s description advertises seeds its own
   validator rejects.** A single shared `SET_DESCRIPTION`
   (`src/mcp/required-sections-tools.ts`) was interpolated into both the
   project-baseline and package tools, advertising `"baseline"` and
   `{ packageId }` as accepted `seedFrom` values. `validateSeedForScope`
   (`src/db/queries/required-sections.ts`) throws for anything but `"toc"`
   on the baseline scope — the description was actively lying to the model
   about what the same call would do.

All three share a failure mode: **the agent-facing surface loses
information REST already carries**, either about an error (1, 2) or about
what will be accepted before the call is even made (3).

## Decision

### D1 — `ToolError` gains an optional `structuredContent` field, not a new result variant

```ts
export type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
};
```

`toolError(text, options?)` gains a second, optional parameter:

```ts
export interface ToolErrorOptions {
  readonly structuredContent: Record<string, unknown>;
}
export function toolError(text: string, options?: ToolErrorOptions): ToolError;
```

`structuredContent` is required _within_ `ToolErrorOptions` — the only
reason to pass the options object at all is to carry structured data, so a
required inner field avoids a meaningless empty-options call. The field name
matches the MCP protocol's own `structuredContent` result field, not an
invented convention, so clients that already read it on success paths gain
support for conflict-class failures for free. This keeps the
"MCP tools never throw" contract intact: `content` (human-readable text) is
always present and unchanged; `structuredContent` is additive, so a client
that ignores it sees exactly the same result it saw before. All ~15
pre-existing `toolError(text)` call sites remain valid unchanged.

`lock_spec` is the first consumer: a held lock now returns

```ts
toolError(`spec is locked by ${result.holder} until ${result.expiresAt}`, {
  structuredContent: { holder: result.holder, expiresAt: result.expiresAt },
});
```

— field-for-field matching REST's 409 body, with the original prose
preserved in `content`.

`unlock_spec`'s "no lock held by this holder" failure is **explicitly not
converted**: it has no holder/expiresAt-equivalent payload, so wrapping it
would be churn with no informational gain.

### D2 — Header/footer scope errors reuse `src/lib/pg-errors.ts`, not `src/api/`

`docs/architecture/module-boundaries.md` permits `mcp/` to import from any
`lib/` util but forbids importing `api/` internals. REST's `mapWriteError`
itself is built on `pgErrorToHttp` (`src/lib/pg-errors.ts`), so the fix lifts
that shared classifier into `headerFooterToolError` directly rather than
importing `src/api/header-footer.ts` or duplicating the pg-code mapping:

```ts
function headerFooterToolError(err: unknown): ToolResult | null {
  if (err instanceof HeaderFooterValidationError || err instanceof HeaderFooterScopeError) {
    return toolError(err.message);
  }
  const mapped = pgErrorToHttp(err, { '23503': 'referenced scope not found' });
  return mapped ? toolError(mapped.error) : null;
}
```

This is applied unconditionally across whatever codes `pgErrorToHttp`
classifies (`23503`/`23505`/`23514`), exactly mirroring `mapWriteError`'s own
unconditional call — filtering to `23503` only would have been a _partial_
match, not the anti-drift guarantee the issue asked for. `internalError()`
still exists as the fallback for genuinely unclassified errors; its
effective trigger set only shrinks.

### D3 — Required-sections descriptions are two hand-written constants, not a live derivation

`validateSeedForScope` restricts `seedFrom` only on the baseline/project
scope (to `"toc"`); package scope has no such restriction, so the
pre-existing shared description was already accurate for package scope and
wrong only for baseline. The fix splits it into
`BASELINE_SET_DESCRIPTION` (advertises `"toc"` only) and
`PACKAGE_SET_DESCRIPTION` (unchanged text — the full seed set). Both are
plain string constants, not derived from `validateSeedForScope` at runtime:
that function is private to a file outside this issue's owned paths
(`src/db/queries/required-sections.ts`), and exporting it purely to satisfy
a doc-string felt like the wrong footprint for a LOW-severity, string-only
fix. A regression test pins the description/validator agreement in its
place, so a future change to `validateSeedForScope` that isn't mirrored here
fails loudly instead of silently drifting again.

### D4 — Other 409-equivalent tools are surveyed, not converted, in this change

The issue asks to "survey the other 409-equivalent tools ... and either
convert them in this change or record in the PR body why they wait." A grep
for `StaleVersionError`/`SpecWriteForbiddenError` (the edit-gate /
version-conflict error classes per `src/api/edit-gate-response.ts`) across
`src/mcp/*.ts` outside this issue's owned paths found exactly two consumer
files:

- `src/mcp/merge-handlers.ts`
- `src/mcp/paragraph-handlers.ts`

Neither file is in this issue's owned paths, and converting them is a
separate demonstrable change: it needs its own regression tests per tool and
its own decision about which fields each conflict class should carry
(`stale_version` wants the current version; `write_forbidden` wants the
gating reason — neither maps onto `lock_spec`'s `holder`/`expiresAt` shape).
Folding that into this PR would widen it past one reviewable change without
making either conversion better. They are deferred, not forgotten — #583
tracks applying the `structuredContent` pattern established here to those
two files' 409-equivalent branches.

## Consequences

- Any future MCP tool that needs to hand an agent machine-readable
  conflict/error data has a ready-made, backward-compatible channel
  (`toolError(text, { structuredContent })`) instead of reinventing prose
  parsing or a bespoke result shape per tool.
- Header/footer scope errors and REST's `mapWriteError` now share a single
  pg-code classification point (`src/lib/pg-errors.ts`); a future pg-code
  addition there benefits both surfaces automatically instead of requiring
  a matched edit in two places.
- The required-sections description split is enforced only by a test, not
  the type system — if `validateSeedForScope`'s accepted seed set changes
  without updating `required-sections-tools.test.ts`, the test fails but
  nothing else does. Acceptable for a LOW-severity doc-accuracy fix; revisit
  if `validateSeedForScope` moves into an owned/exported path.
- `merge-handlers.ts` and `paragraph-handlers.ts` still fold their
  edit-gate/version-conflict 409-equivalents into prose-only `toolError`
  calls; agents consuming `stale_version`/`write_forbidden`-class failures
  from those tools still cannot act on structured fields until a follow-up
  issue applies this ADR's pattern there.
