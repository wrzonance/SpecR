# ADR-019: Scope Boundaries — Content-Neutral Platform

## Status: Accepted

## Context

Specification tooling is often expected to include: manufacturer/product content
libraries (cut sheets, O&M manuals, installation guides, submittal templates),
subscription codes-and-standards reference content, native mobile apps, and multilingual
master libraries. Each is a real capability with real users, and each will surface as a
feature request. Scope discipline requires deciding, explicitly, which of these SpecR
builds.

SpecR's wedge is structure: canonical AST as source of truth (ADR-003), round-trip
fidelity (ADR-004/005), BIM integration (ADR-009), AI-native access (ADR-010) — open
source, headless, no per-seat content licensing.

## Decision

**SpecR is a content-neutral platform. It is never a content provider.**

Declined as product scope:

1. **Bundled product/manufacturer content.** SpecR will not ship, license, or resell cut
   sheets, O&M manuals, installation guides, submittal templates, or codes/standards
   reference databases. Rationale: it converts an MIT-licensed tool into a content
   licensing business; it creates exactly the copyright entanglement ADR-013 was written
   to avoid; and document *transport* for such collateral already belongs to the DMS
   connectors (ADR-014). The platform's job is to structure and trace content the firm
   brings — not to be the content.

2. **Native mobile / field applications.** ADR-002 places every client above the OpenAPI
   boundary. A field app is a client anyone can build against REST + MCP; building one in
   core forks the surface and dilutes the headless contract.

3. **Multilingual master libraries** (e.g. bilingual French/English masters). The AST is
   language-agnostic plain text; translation is content duplication, not structure. Absent
   a concrete market driver this is pure scope. If it arrives, it maps onto the library
   tier model (ADR-015) as parallel libraries — no architectural provision is needed
   today.

Affirmed — the other side of the same boundary (in scope, backlog):

- **External content association.** Linking firm-owned collateral (e.g. PDF datasheets) to
  paragraphs/sections — an association model plus the DMS connector as transport. SpecR
  stores links and provenance, never the licensed bytes as product content.
- **BYO-license content ingestion.** Firms subscribing to master-content or
  standards-reference services may connect and ingest that content into their own
  libraries (ADR-015) under their own license, including periodic update pulls. SpecR
  provides the adapter seam (the ADR-014 plug-in philosophy applied to content sources);
  the firm provides the entitlement. Ingested content lives in firm-owned libraries,
  carries `origin_meta` provenance, and is never redistributed by SpecR.
- **SpecsIntact `.SEC` generation** is explicitly *not* declined — it stays on the backlog
  as a generator output format (ingest already exists).

## Consequences

- Feature requests for bundled content, mobile apps, or translated masters are closed with
  a pointer to this ADR — "not now" with a recorded why, reversible only by superseding
  this decision.
- Content ingestion adapters must keep license compliance on the firm's side of the line:
  per-firm credentials, content marked with origin (`origin_meta`, ADR-015), no
  cross-tenant sharing of ingested licensed content. An adapter that cannot meet that bar
  does not ship.
- The list of "what SpecR never bundles" extends the legal posture ADR-013 started: the
  product remains redistributable under MIT precisely because no licensed content rides
  in it.

## Related

- ADR-002 (headless boundary), ADR-013 (public-domain seed posture), ADR-014 (connector
  philosophy), ADR-015 (libraries + `origin_meta`)
