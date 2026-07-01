# ADR-042: Umbrella Call-Out Check Covers All Divisions

## Status

Accepted. Supersedes [ADR-037](037-umbrella-subordinate-coordination.md).

## Context

ADR-037 introduced the `umbrella_not_called_out` coordination finding: a subordinate section
`DD XX YY` should reference its division umbrella `DD 00 00`, and the report flags subordinates
that do not. To avoid asserting unreviewed relationships, ADR-037 restricted the check to an
explicit registry of three divisions — `26`, `27`, `28` — where the `DD 00 00` general-requirements
pattern is well established. Sections in any other division were skipped and merely named in a
report note ("umbrella call-out check covers only divisions 26, 27, 28; skipped divisions: …").

That restriction has become the wrong default:

- **The umbrella pattern is a MasterFormat convention, not a divisions-26–28 convention.** `DD 00 00`
  is the general-requirements section for *any* division `DD`; a subordinate that never cites it is
  a coordination gap regardless of the division number. Silently skipping divisions 03, 07, 08, 09,
  … under-reports real gaps.
- **The check is already reference-based and conservative in the right way.** It only fires when a
  present subordinate omits a citation to its own `DD 00 00`. It does not require the umbrella spec
  to be loaded, and it does not invent relationships — it reports the *absence of a citation the
  author could reasonably be expected to make*. That logic is division-agnostic.
- **The "skipped divisions" note advertised a limitation as if it were a policy.** Reviewers read
  "covers only divisions 26, 27, 28" as a deliberate rule rather than an implementation stopgap.

The web UI demo's coordination panel surfaced this directly: its copy hardcoded the 26/27/28 wording,
so the demo told users the check was division-limited even though nothing about the underlying gap is
division-specific.

## Decision

Generalize the umbrella call-out check to **every division present in scope**. Drop the
`SUPPORTED_UMBRELLA_DIVISIONS` / `SUPPORTED_SET` registry and the `skippedDivisions` computation.

- For every present section with a parseable division `DD`, the umbrella section is `DD 00 00`.
- A present section is a subordinate when it is not itself `DD 00 00`.
- A subordinate satisfies the rule when any extracted section reference in it points at `DD 00 00`,
  in Related Sections or body text — unchanged from ADR-037.
- A subordinate with no such reference produces an `umbrella_not_called_out` finding — now in any
  division, not only 26/27/28.

Replace the "skipped divisions" note with a positive, dynamic coverage note that names what was
actually checked:

```
umbrella call-out check covers all divisions in scope: 03, 05, 26
```

The note lists the sorted, de-duplicated divisions of the present sections. Empty scope emits no note.

The finding shape (`umbrella_not_called_out` with `sourceSpecId` / `sourceSpecSection` /
`umbrellaSpecSection`), the summary field (`umbrellaNotCalledOut`), the reference-based satisfaction
rule, and the deterministic-and-pure / no-migration properties are all retained from ADR-037. REST and
MCP inherit the change because both surface `getCoordinationReport`; the API shape is unchanged, so no
`openapi.yaml` change is required.

## Consequences

- Projects that load subordinate sections outside divisions 26–28 without citing their `DD 00 00`
  umbrella will now see `umbrella_not_called_out` findings that were previously suppressed. This is
  the intended correction, not a regression; `umbrellaNotCalledOut` counts and `total` rise
  accordingly on such projects.
- The report note is now always present when any section is in scope (naming the covered divisions)
  instead of appearing only when a division was skipped. The demo's coordination copy becomes correct
  automatically because it renders `report.notes` verbatim — no hardcoded division list remains.
- ADR-037's "false positives in unreviewed divisions" concern is accepted as the cost of completeness:
  the check reports a *missing citation*, which is a defensible signal in any division, and reviewers
  can dismiss individual findings. We prefer over-surfacing a citable gap to silently hiding it.
- Because the check can still require a call-out to an umbrella not loaded in the current scope, a
  reviewer may see this finding alongside a missing-section signal — unchanged from ADR-037.

## Alternatives Considered

- **Keep the registry but expand it division by division as each pattern is reviewed.** Rejected. The
  umbrella pattern is a general MasterFormat convention; maintaining a hand-curated allow-list is
  ongoing toil that keeps under-reporting real gaps in the meantime.
- **Drop the coverage note entirely.** Rejected. The demo epic (X1) explicitly asked that the displayed
  copy update dynamically rather than disappear; a positive "covers all divisions in scope: …" note
  keeps the reviewer informed about exactly what the check examined.
- **Require the umbrella spec to be present before flagging.** Rejected for the same reason as in
  ADR-037: the coordination question is whether the subordinate *cites* its umbrella, including when the
  umbrella is issued outside the current package.

## Related

ADR-037 (superseded — original umbrella rule), ADR-023 (division-general spec inheritance),
ADR-029 (coordination report), ADR-024 (reference traversal), ADR-026 (OpenAPI contract), issue #264.
