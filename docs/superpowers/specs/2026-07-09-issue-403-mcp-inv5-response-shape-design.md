# Design — #403: MCP INV-5 tool-response-shape validation (close ADR-044 gap)

**Status:** Approved (brainstorm 2026-07-09)
**Issue:** #403 (test/ci)
**Module:** `src/mcp/` (contract gate)
**ADR:** ADR-044 §79–81 (this closes its tracked gap); ADR-026 is the REST precedent to mirror.

## Context

The MCP contract gate (`src/mcp/contract.integration.test.ts`) enforces INV-1/2/2b/3/4:
operation↔tool coverage and write-tool **request** fields. It does **not** validate tool
**response** shapes — ADR-044 §79–81 explicitly parks that as "a tracked future gap." Tools
return `ToolResult` (`{ content: [{ type:'text', text: <JSON> }], isError? }`) with no output
schema today. Agent-facing consumers (#353 grounded reporting, demo MCP chat, external MCP
clients) depend on stable typed outputs; today a tool's payload can drift silently while the
gate stays green because the tool still *exists*.

## Approach (decided in brainstorm) — reuse the OpenAPI response schema

Tools are already contract-bound to REST ops via `OP_TO_TOOL` (contract-map.ts). REST responses
are already schema-validated against OpenAPI (ADR-026, `contract.integration.test.ts` REST side,
`test-utils/contract/validate-response`). **INV-5 reuses that:** for each user-facing tool, take
its mapped REST op's OpenAPI success-response schema, invoke the tool, parse the JSON payload out
of `content[].text`, and validate it against that schema. DRY, contract-bound, and it auto-tracks
REST drift — no second source of truth.

**Non-mirroring tools** (a tool whose output legitimately summarizes / reshapes rather than
returning the REST body 1:1) are handled by an explicit, documented opt-out map — e.g.
`INV5_SHAPE_EXEMPT: ReadonlyMap<toolName, reason>` — mirroring how `MCP_UNEXPOSED` documents
coverage exemptions. An exemption is a reasoned entry, never silent.

## Data shapes / interfaces

```ts
// contract-map.ts (or a sibling) — explicit, reasoned exemptions
export const INV5_SHAPE_EXEMPT: ReadonlyMap<string /*tool*/, string /*reason*/>;

// contract.integration.test.ts — new
it('INV-5: every user-facing tool output validates against its mapped op response schema', ...)
```

The test iterates `OP_TO_TOOL`, skips `INV5_SHAPE_EXEMPT` (asserting each exemption references a
real tool + carries a reason), invokes each remaining tool with representative seeded args, and
runs the OpenAPI response validator over the parsed payload.

## Invariants (tests)

1. Every non-exempt user-facing tool's success output validates against its mapped op's OpenAPI
   response schema.
2. `INV5_SHAPE_EXEMPT` and `OP_TO_TOOL` reference only real tools/ops; every exemption has a
   non-empty reason (mirrors the existing "disjoint + real ops" test for MCP_UNEXPOSED).
3. A deliberately-malformed tool payload fails INV-5 (guard test proving the check has teeth).

## Testing

- Integration test (needs DB + seed, like the existing MCP contract integration tests): invoke
  each mapped tool against seeded data, validate output shape.
- Reuse `test-utils/contract/validate-response` — do not fork a second validator.
- Requires `pnpm migrate → pnpm seed` first (per repo CI order) — tools like `list_sections`
  depend on seeded `spec_sections`.

## Deliverables

- INV-5 test in `contract.integration.test.ts`.
- `INV5_SHAPE_EXEMPT` map (with reasons) if any tool legitimately doesn't mirror its REST op.
- Update ADR-044 to mark the response-shape gap **closed** by INV-5 (openapi.yaml/ADR prose kept
  accurate per repo rule).
