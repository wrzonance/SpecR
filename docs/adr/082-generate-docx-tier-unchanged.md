# ADR-082: generate_docx keeps its `read` tier even with the readiness gate reachable

## Status

Accepted

## Context

\#567 wires `generate_docx`'s MCP tool through to the ADR-079 issuance-readiness gate — the same
`assertReadyForFinal`/`ReadinessBlockedError` call REST's `enforceReadinessGate` already makes, now
reachable from `generate_docx`'s `mode`/`overrideReadinessGate` body fields (spread from the shared
`GenerateBodySchema`, matching REST's own request shape). The issue that opened this workstream (#550
Workstream A) flagged this explicitly: _"`overrideReadinessGate` is capability-sensitive — decide and
document whether it stays exposed at the `write` tier or is gated."_

`generate_docx` has been `TOOL_TIERS.get('generate_docx') === 'read'` (`src/mcp/capabilities.ts`)
since the tier map was introduced (ADR-045) — it reads a spec's stored tree and renders bytes back to
the caller; it writes nothing to the database. `overrideReadinessGate: true` changes what those bytes
contain (an unresolved-findings document instead of a 422), but does not add a persisted side effect.

## Decision

**`generate_docx` stays `'read'`.** `overrideReadinessGate` is not promoted to `write`, and no new
tier or per-parameter gate is introduced.

1. **No DB mutation occurs regardless of the flag.** `handleGenerateDocx` (and REST's
   `generateHandler`) call `getSpecTree`, resolve rules/options, and render a DOCX buffer — every
   branch, including the override branch, is read-only. Reclassifying the whole tool as `write`
   because one of its optional inputs can suppress a validation error would misrepresent every other
   call to this tool (the overwhelming majority, which pass no `mode` at all) as a mutation.

2. **No per-parameter tier-enforcement mechanism exists anywhere in this codebase.** `TOOL_TIERS`
   (`src/mcp/capabilities.ts`) and `MCP_ALLOWED_TIERS` gate whole tools, not individual optional
   fields on a tool's `inputSchema`. Introducing parameter-level tiering for this one flag would be a
   new capability primitive built for a single call site, with no other candidate in the tool surface
   that needs it — speculative infrastructure this repo's `code.md` DRY guidance argues against.

3. **REST requires no elevated scope for the identical parameter.** `POST /specs/:id/generate`
   accepts `overrideReadinessGate` under the same authorization REST already requires for any
   `generate` call — there is no REST-side "requires a stronger role" gate on this field either.
   Gating the MCP tool more tightly than its REST counterpart for the same input would make the two
   surfaces diverge on authorization semantics, the opposite of ADR-044's contract-parity goal.

4. **The gate itself is the real control, not the tool tier.** `overrideReadinessGate` does not
   bypass validation — it bypasses a _refusal_. Every finding it lets through was already visible via
   `readiness_report` (a `read`-tier tool) before the call, and the generated DOCX still reflects the
   spec's actual current content; nothing is fabricated or silently mutated. The tier system answers
   "can this caller reach this tool at all," which is orthogonal to "should a **final**-mode render be
   allowed to proceed with outstanding findings" — the latter is ADR-079's concern, already decided
   and already unaudited-by-design at this layer (ADR-079 Decision 8, tracked for a real audit trail
   at #380–#382).

## Consequences

- `generate_docx` remains reachable under the default `MCP_ALLOWED_TIERS=read,write` and even under a
  hypothetical `read`-only deployment — matching its pre-#567 reachability exactly. No deployment that
  worked before this change loses access to `generate_docx` because of this change.
- `overrideReadinessGate: true` is available to any caller who can already call `generate_docx` at
  all — the same blunt, unaudited bypass ADR-079 Decision 8 already accepted for REST, now reachable
  from MCP too. This is a widening of _reachability_, not a widening of _authorization_: REST already
  allowed exactly this for the same field.
- If a future audit-trail feature (#380–#382) introduces per-action authorization finer than tool
  tiers, `overrideReadinessGate` is the natural first candidate to gate under it — this ADR does not
  foreclose that; it only records that no such mechanism exists today, so none is invented ad hoc here.
