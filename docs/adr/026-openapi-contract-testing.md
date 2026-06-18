# 026 — OpenAPI as hand-authored contract, verified by tests (not generated from code)

## Status
Accepted

## Context
`openapi.yaml` is the authoritative API contract and is hand-maintained, so it can drift from
the code. We want a public, interactive API reference that is trustworthy. Options: (a) generate
the spec from code; (b) contract-test the hand-authored spec; (c) lint/route-coverage only.

## Decision
Keep `openapi.yaml` hand-authored and **enforce its truth in CI**:
1. `redocly lint` — structural validity (already in CI).
2. Response contract test — real responses validated against documented JSON schemas (ajv 2020).
3. Bidirectional route↔spec coverage — every Express route is documented and vice-versa.
Generation-from-code is rejected: it would refactor every route and lose the readable, reviewable
hand-authored spec, for a marginal gain over (2)+(3).

## Scope of the guarantee
Enforcement covers **JSON response bodies** for covered/allowlisted operations. It does NOT cover
request bodies, negative inputs, headers/content-negotiation, or binary/multipart media types
(e.g. the DOCX `generate` endpoints). These are explicit, tracked gaps — not silent coverage.

## Consequences
- New endpoints must be documented or CI fails (coverage gate).
- Documented responses cannot silently drift for covered ops.
- A response allowlist tracks not-yet-verified ops; it is burned down over time.
- Future option held in reserve: `express-openapi-validator` for wholesale response validation.
