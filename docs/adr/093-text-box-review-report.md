# ADR-093: dedicated text-box review report

## Status

Accepted

## Context

ADR-072 already retains body-level DrawingML/VML text boxes as `object` nodes
with `objectText` children. The remaining gap is reviewer visibility: the
existing `get_spec` tree exposes the complete opaque object model, but there is
no focused per-spec or per-project list that lets an editor route each text box
for removal. Open Word comments are a different source fact with different
resolution semantics, so folding text boxes into the open-comments report
would misrepresent the data and its lifecycle.

## Decision

Expose a dedicated read-only text-box report at both spec and project scope:

- `GET /specs/{id}/text-boxes`
- `GET /projects/{id}/text-boxes`
- MCP `text_boxes_report`, accepting exactly one of `specId` or `projectId`

Each item reports the owning spec and section, the `object` paragraph UUID,
the persisted `floating` and `generation` metadata, and the ordered extracted
text from its `objectText` children. The query validates `object_data` through
the existing `ObjectMetaSchema`, filters `kind: textBox`, and excludes owner-
removed subtrees. Tables are therefore never reported by this surface.

This is a report of retained source facts, not a new AST or parser model. It
does not regenerate shapes, classify reviewer/editor ownership, or change the
ADR-079 `body_object_present` readiness finding. Callout-vs-text-box remains a
known ambiguity: ADR-072's persisted classification is the narrowest supported
fact, so the report does not invent a `callout` subtype.

## Consequences

Review clients get one compact, deterministic list suitable for routing and
navigation without traversing every paragraph. REST and MCP share the same DB
report payload, while MCP keeps the existing JSON-content transport envelope.
Future shape-specific classification or round-trip editing can extend the
object model independently without changing this report's contract.
