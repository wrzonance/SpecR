# ADR-043: Emit `present_not_required` even when no TOC is authored

## Status

Accepted (2026-07-01). **Supersedes the empty-required suppression decision in
[ADR-029](029-coordination-report.md)** (its "Empty required list ⇒ suppress
`present_not_required`" bullet). All other ADR-029 decisions stand.

## Context

ADR-029 deliberately suppressed the `present_not_required` finding class whenever
a project/package had **no authored `required_sections`** (empty TOC), pushing a
`notes[]` advisory instead:

> "With no authored intent there is no opinion on what is 'extra'; flagging every
> present section as unrequired would be noise."

In practice this makes the coordination report's PRESENT-NOT-REQUIRED category
appear **broken** to a user who has loaded specs but not yet authored a TOC: the
category is silently empty with only a note explaining the skip. The demo's live
coordination-audit view surfaced exactly this — three specs loaded into a project
with no TOC showed zero present-not-required findings, reading as a non-functional
feature rather than a deliberate suppression.

The suppression conflates two distinct states: "you have a TOC and everything
present is in it" (genuinely nothing extra) versus "you have no TOC yet" (we
simply have nothing to compare against). Both rendered as an empty category.

## Decision

**Always compute `present_not_required` as `present ∖ required`**, including when
`required` is empty (in which case every present spec is trivially reported).
The `required` set being empty is no longer a special case for this finding class:

- With an authored TOC → present specs not in the TOC are flagged (unchanged).
- With **no** authored TOC → **every** present spec is flagged as
  present-not-required, because none of them is in the (empty) TOC.

`required_not_present` is unaffected — it is `required ∖ present`, which is
naturally empty when `required` is empty, so no code change is needed there.

The explanatory `notes[]` entry is **kept but reworded** from "…present/required
comparison skipped" to:

> "no required sections authored at this scope — every present section is reported
> as present-not-required"

so a reader understands *why* every present spec is flagged (it is not that they
are all genuinely extraneous; it is that no intent has been authored to compare
against). The note is what keeps the flood self-explaining rather than alarming.

## Consequences

- **The category is functional out of the box.** A project with loaded specs and
  no TOC now shows its present specs as present-not-required, matching user
  expectation, instead of an unexplained empty list.
- **More findings for unauthored-TOC projects** — every present spec is listed.
  This is the "noise" ADR-029 sought to avoid; it is mitigated by (a) the reworded
  note framing it, and (b) the finding being advisory. Consumers that want a
  quiet report should author a TOC (the intended workflow; the demo ships a TOC
  builder). A future refinement could give this class a lower "info" severity in
  clients when the TOC is empty.
- **Contract unchanged.** `FindingPresentNotRequired`'s schema is identical; only
  the *frequency* of emission changes, plus the reworded free-text note (the
  `notes[]` array is untyped string in `openapi.yaml`, so no schema drift).
- **The open-union extensibility contract of ADR-029 is untouched** — this is a
  semantics change to one existing finding class, not a new type.

## Related

- [ADR-029](029-coordination-report.md) — the coordination report design this
  amends (empty-required suppression reversed here).
- ADR-028 (`required_sections` substrate / the TOC intent set).
- Issue #105 (coordination report), and the live-demo review that surfaced the
  perceived breakage.
