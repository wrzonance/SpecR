# ADR-037: Umbrella-Subordinate Coordination

## Status

Accepted

## Context

ADR-023 introduced `division_general_specs` so a project or library can identify an exact
`NN 00 00` division-general section without overloading copy provenance. That model answers
"what is the division general context for this scope?" It does not answer the coordination
question from #264: "does each subordinate section call out its umbrella?"

The first useful umbrella set is intentionally narrow. Divisions 26, 27, and 28 commonly
use `26 00 00`, `27 00 00`, and `28 00 00` as broad general requirements over the rest of
their division. Other divisions may have similar patterns, but the project does not yet have
enough reviewed knowledge to assert them without false positives.

The coordination report already classifies section references from `spec_references` by
source spec and article role for the related-section checks. Reusing that classified reference
set avoids a second citation scanner and keeps this rule tied to the parser's existing
cross-reference extraction.

## Decision

Add an umbrella-subordinate membership rule to the coordination report:

- Supported umbrella divisions are an explicit registry: `26`, `27`, `28`.
- The umbrella section for division `DD` is the exact MasterFormat number `DD 00 00`.
- A present section is a subordinate when its section number starts with `DD ` and is not
  itself `DD 00 00`.
- A subordinate satisfies the rule when any extracted section reference in that subordinate
  points at `DD 00 00`, whether the reference appears in Related Sections or in body text.

This deliberately aligns with ADR-023's exact-section model but does not reuse
`division_general_specs` as a required join. `division_general_specs` remains the in-scope
context table; the call-out rule is a reference rule and can legitimately require a citation
to an umbrella issued elsewhere. A missing or external `DD 00 00` may therefore still be the
expected call-out target.

Emit a new coordination finding when a supported subordinate has no such reference:

```ts
{
  type: 'umbrella_not_called_out',
  sourceSpecId: string,
  sourceSpecSection: string,
  umbrellaSpecSection: string
}
```

Partial coverage is explicit. If the report contains sections from unsupported divisions,
the check skips those divisions and adds a report note naming the checked divisions and the
skipped divisions. Unsupported divisions never produce `umbrella_not_called_out` findings.

## Consequences

- The finding is additive to ADR-029's discriminated `CoordinationFinding` union and summary.
  REST and MCP inherit the same result because both surface `getCoordinationReport`.
- The rule is deterministic and pure: present sections plus classified section references are
  sufficient to compute findings and notes. No migration or report-time writes are required.
- Divisions outside 26/27/28 remain silent as findings but visible as a limitation through
  `notes[]`, which prevents users from mistaking partial coverage for complete MasterFormat
  knowledge.
- Because the check can require a call-out to an umbrella not loaded in the current scope, a
  reviewer may see both this finding and another missing-section signal in future workflows.
  That is intentional: one says "cite the umbrella," while the other says "load or require
  the umbrella document."

## Alternatives Considered

- **Infer umbrellas for every `DD 00 00` division.** Rejected for now. It would look tidy but
  would assert unreviewed relationships and create false positives in divisions where the
  general section pattern is not a project rule.
- **Require the umbrella spec to be present in the report scope.** Rejected. ADR-023 already
  records whether a division general spec is in scope; the coordination question is whether
  a subordinate cites the expected umbrella, including when that umbrella is issued outside
  the current package.
- **Scan paragraph text again for `DD 00 00`.** Rejected. `spec_references` is the existing
  parser-owned reference substrate used by the coordination report; a second scanner would
  drift from related-section and dangling-reference behavior.

## Related

ADR-023 (division-general spec inheritance), ADR-029 (coordination report), ADR-024
(reference traversal), ADR-026 (OpenAPI contract), issue #264.
