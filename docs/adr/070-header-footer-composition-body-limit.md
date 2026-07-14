# ADR-070: header/footer composition PUT body-size limit

## Status

Accepted

## Context

ADR-069 (#308) added an `'image'` field kind to `HeaderFooterFieldSchema`
(`src/ast/header-footer-schemas.ts`), with `imageData`'s base64 string
capped at `MAX_IMAGE_BASE64_LENGTH` — 6,990,508 characters, derived from
`MAX_IMAGE_BYTES` (5 MB decoded) in `src/lib/image-media-type.ts`. That
cap is enforced by Zod, but Zod never sees an oversized request: `src/
index.ts` dispatched every non-`/mcp` route through a single
`express.json()` with no `limit` option, so Express's library default of
100 KB rejected the request at the body-parser layer first. A composition
carrying a real logo (even a modest ~200 KB PNG, ~267 KB base64) 413'd
before validation ever ran. The schema advertised a capability the
transport made unreachable through the documented JSON write endpoints
(#490) — only DOCX capture (`multipart/form-data`, a separate code path)
could actually deliver an image that large.

This is a genuine security/DoS tradeoff, not a one-line fix: `src/
index.ts`'s existing comment on the 100 KB default is deliberate posture,
and any widening has to be justified per-route, not applied globally.

## Decision

### Route-scoped limit, not a global raise

Only the four `PUT .../header-footer` composition-write routes
(`libraries|projects|packages|revisions/{id}/header-footer`) get the
larger limit, via a second `express.json({ limit })` instance selected by
a path+method predicate ahead of the existing single-branch dispatch in
`src/index.ts`. Every other REST route — including the composition's own
`GET`, `DELETE`, and the three read-only `/header-footer/resolved`
views — keeps the 100 KB default unchanged. `GET`/`DELETE` never carry a
body, so widening their limit would buy nothing while needlessly growing
the request-body DoS surface those routes are otherwise protected by. The
predicate (`isHeaderFooterCompositionWrite`,
`src/api/header-footer-body-limit.ts`) is pure, total, and never throws,
matching the existing REST middleware's error-handling posture — a
malformed `req.path` degrades to "not a header/footer write" rather than
crashing the dispatch chain.

### The limit is derived, never hand-copied

`HEADER_FOOTER_JSON_BODY_LIMIT_BYTES = MAX_IMAGE_BASE64_LENGTH +
HEADER_FOOTER_BODY_ENVELOPE_BYTES` (6,990,508 + 262,144 = 7,252,652
bytes, ≈ 6.92 MiB). Importing `MAX_IMAGE_BASE64_LENGTH` from `src/lib/
image-media-type.ts` rather than restating its numeric value means the
transport limit cannot silently fall out of sync with the schema cap it
exists to accommodate — if a future change raises or lowers
`MAX_IMAGE_BYTES`, this limit moves with it automatically. The 256 KiB
envelope is the one implementer judgment call the issue explicitly
delegated: headroom for the surrounding composition JSON (region/cell
structure, other text fields, JSON syntax overhead) beyond the one image
field itself.

### Single-image sizing is an accepted, documented limitation

The derived limit is sized for **one** image field at
`MAX_IMAGE_BASE64_LENGTH` plus envelope — not for a composition with
several near-max-sized images across multiple cells, each individually
passing its own Zod field bound but collectively exceeding
`HEADER_FOOTER_JSON_BODY_LIMIT_BYTES`. This matches the issue's literal
framing (a single logo/image field) and is out of scope to fix here;
widening further to cover N images would mean either an unbounded limit
(defeating the DoS rationale entirely) or a per-request image-count
policy, neither of which the issue asked for. A future slice can revisit
this if multi-image compositions become a real requirement.

### 413 discriminated by body-parser's own `.type`, not bare `.status`

`src/api/middleware/error.ts` gained a branch recognizing
`err.type === 'entity.too.large'` — the field `body-parser` (which
`express.json()` wraps) documents and sets specifically for this failure
— ahead of the generic fallback. The existing fallback already read
`err.status` and would emit `413` for this same error, but with the
generic, wrong-shaped message `'internal server error'`; discriminating
on `.type` instead of trusting any `err.status === 413` avoids
misclassifying a future business-logic 413 that isn't a body-size
rejection. Because the fix lives in the shared error handler rather than
a route-local catch, it corrects the response body for **every** route
that hits the default 100 KB limit, not just the four header/footer
writes — a pre-existing correctness gap this closes as a side effect,
not scope creep, since the middleware is a single shared surface.

### `openapi.yaml` documents the derived limit, not a duplicated constant

A new `components.responses.PayloadTooLarge` (sibling to the existing
`UnprocessableEntity`/`TooManyRequests`/`InternalServerError` shapes) is
referenced as `'413'` on exactly the four PUT operations
(`putLibraryHeaderFooter`, `putProjectHeaderFooter`,
`putPackageHeaderFooter`, `putRevisionHeaderFooter`). Its description
states the literal derived byte bound (7,252,652) and names the
constants it's derived from, so a future reader auditing the contract
sees the relationship rather than an unexplained number. Sibling
`GET`/`DELETE` operations and the three `/resolved` reads are untouched —
they were never candidates for this response.

### Option 3 (capture-only) was rejected

The issue raised, as one option, treating DOCX capture as the only
supported path for multi-megabyte image content and aligning the
JSON-write schema cap down to match the REST default instead of raising
the transport limit. This was explicitly rejected: the composition
schema is meant to be authorable directly via the JSON write endpoints
(not solely produced by capture), and shrinking `imageData`'s cap to fit
the 100 KB default would make a legitimately-sized single logo
unrepresentable through the documented write API — reintroducing the
same gap from the other direction. Multipart DOCX capture remains a
separate, pre-existing, and entirely unaffected code path (it was never
routed through `express.json()`); this ADR only closes the gap for the
JSON PUT endpoints.

## Follow-up: schema-level size invariant closes the .catchall gap (code review, #490)

A code-review pass on this ADR's implementation found that every level of
`HeaderFooterCompositionSchema` (top-level object plus every nested
Region/Cell/Field/Variant/RawSidecar schema) is `.catchall(JsonValue)`
(ADR-021's open-extension contract), with no size bound on the extension
values themselves. That meant a composition Zod would call *valid* — one
image, everything else nominal — could still carry unbounded data in an open
extension key and exceed `HEADER_FOOTER_JSON_BODY_LIMIT_BYTES`, contradicting
this ADR's premise that the derived limit accommodates every schema-valid
single-image write. Unlike the multi-image gap below (an explicit,
accepted-out-of-scope limitation), this one was an unintended gap between
what the schema called valid and what the transport limit actually allowed.

Fixed by adding one size-invariant `.check` — on a **write-only** schema,
`HeaderFooterCompositionWriteSchema` (`src/ast/header-footer-schemas.ts`) —
that rejects any parse whose serialized byte length exceeds
`HEADER_FOOTER_JSON_BODY_LIMIT_BYTES`, enforced once at the top level so it
covers overage contributed by any nested catchall without duplicating a
per-field cap into every one of them. The four `PUT .../header-footer` routes
(`validateBody`) and the MCP `set_*_header_footer` tools validate against this
write schema; the bare structural `HeaderFooterCompositionSchema` — the shape
every read/parse path uses — omits it. Because `ast/` may not import from
`api/` (module-boundaries.md), the shared constant moved to
`src/lib/header-footer-body-limit.ts`; `src/api/header-footer-body-limit.ts`
now re-exports it rather than deriving its own copy, so the transport dispatch
and the schema's own invariant can never drift apart.

A second review pass caught why the invariant must be write-scoped: the shared
`HeaderFooterCompositionSchema` is also re-parsed on read paths.
`resolveHeaderFooterConfig` deep-merges the client → project → package →
revision layers and re-parses the merged result (`src/db/queries/header-footer.ts`),
and DOCX capture re-parses whatever a document holds
(`src/parser/docx/header-footer.ts`). A merged resolution combines several
independently-valid layers — each stored within the budget — and can
legitimately exceed `HEADER_FOOTER_JSON_BODY_LIMIT_BYTES`. Had the invariant
lived on the shared schema, that valid read would throw
`HeaderFooterValidationError` and the resolve endpoint would 500 on data that
was legally stored. Scoping it to writes keeps "Zod-valid write always fits
transport" while letting reads/resolution carry a merged config of any size.
The multi-image accepted limitation described below is a WRITE-side gap only and
remains the only documented one.

## Consequences

- A composition write carrying one image at up to `MAX_IMAGE_BASE64_LENGTH`
  now reaches Zod validation instead of 413'ing at the body-parser layer —
  the capability ADR-069/#308 added to the schema is reachable through the
  REST contract that advertises it, closing the gap #490 reported.
- Every non-header/footer-write route, including the composition's own
  `GET`/`DELETE`, keeps the 100 KB default — the DoS-surface tradeoff is
  scoped to exactly the four routes that need it, not raised globally.
- The 413 response body is now `{"success": false, "error": "payload too
  large"}` everywhere the default limit rejects a request, not just on
  the widened routes — a route-agnostic correctness fix riding along with
  the route-scoped feature.
- Accepted residual limitation, documented rather than silently absorbed:
  a composition with several near-max images can still 413 despite each
  image field individually passing its Zod bound, because the derived
  limit is sized for one image plus envelope. Out of scope for this ADR.
- No DB migration and no AST/schema *shape* change (the composition's fields
  and types are untouched), and no change to `router.ts` route registrations.
  Beyond the transport-dispatch (`src/index.ts`) and contract-documentation
  (`openapi.yaml`) changes, a new **write-only** schema
  `HeaderFooterCompositionWriteSchema` carries one parse-time size *invariant*
  (structural schema + a `.check`) that rejects a write whose serialized bytes
  exceed `HEADER_FOOTER_JSON_BODY_LIMIT_BYTES`, keeping "Zod-valid write" and
  "fits the transport limit" from diverging. The shared
  `HeaderFooterCompositionSchema` used by reads/resolution/DOCX capture stays
  structural (no size bound), so a merged multi-layer resolution never inherits
  the per-write budget. Plus the incidental shared-error-handler correctness fix.
