# ADR-035: Implied Related-Section detection via title keywords

## Status

Accepted

## Context

Coordination report findings already compare authored required sections, present
project specs, broken cross-references, and explicit Related Sections citations
(ADR-029, ADR-033). Issue #261 adds a weaker but useful signal: a spec body can
name the concept of another section without writing the section number. Example:
a conduit spec that says rated-assembly penetrations must be firestopped should
suggest `07 84 00 Firestopping` in Related Sections when it is not already
listed.

This is fuzzy enough to be dangerous if broad words are allowed to fire. The
finding is therefore advisory and precision-biased: missing a weak implication is
better than flooding a coordination report with generic title matches.

## Decision

Add an advisory `implied_related_section` coordination finding. It is derived at
report time, not stored. REST and MCP both consume the same
`getCoordinationReport` result, so the finding has one implementation path.

The keyword source is the project's in-scope section catalog:

- present specs in the project or selected package;
- required sections in that same report scope, with `spec_sections` title fallback
  when the authored row has no title;
- specs available from the project's ordered source libraries, matching the
  library substrate used by project derivation and broken-reference
  `availableFrom`.

The matcher lives in pure functions under `src/coordination/` and the DB layer
only feeds it catalog rows, body paragraphs, and explicit Related Sections refs.

Keyword normalization is deterministic:

- lowercase ASCII word tokenization;
- remove curated stop words and CSI/domain noise such as `general`, `work`,
  `section`, `products`, `execution`, `requirements`, `division`, `electrical`,
  `communications`, `thermal`, and other division-scale terms;
- apply a small local suffix stemmer (`-ing`, `-ed`, `-ies`, `-es`, `-s`) with a
  doubled-final-consonant cleanup so `firestopping` and `firestopped` normalize
  to `firestop`;
- suppress any keyword that appears in more than two catalog section titles for
  that report scope.

The confidence model is intentionally simple. A one-keyword title hit emits
`0.72`; each additional distinct title keyword found in the same paragraph adds
`0.08`, capped at `0.92`. This is not a probability. It is a stable advisory
score for ordering and UI tone. Confidence is **not** a display gate — every
finding surfaces unconditionally — so suppression happens at match time, not in
the score (see the coverage gate below and ADR-050).

Coverage gate (ADR-050): **a lone keyword fires only when it is the title's sole
discriminating keyword; otherwise at least two of the title's keywords must
appear in the paragraph.** A single-keyword title (`Firestopping` → `firestop`)
still fires on one hit, but a multi-keyword title (`ARCHITECTURAL LIGHTING
CONTROL SYSTEM`) is no longer implied by a lone polysemous token like `control`.
This favors precision over recall, consistent with the bias stated above: a body
that echoes only one keyword of a multi-keyword title stops firing, which is
acceptable because that single word is by construction ambiguous.

False-positive suppression rules:

- do not emit a spec's own section;
- do not emit a section already listed under that spec's Related Sections article;
- require the coverage gate above (multi-keyword titles need `>= 2` matches);
- emit at most one finding per source spec and implied section, using the first
  matching paragraph as the locator;
- ignore hidden (`vanish`) and empty paragraphs;
- generic/stop words alone produce no findings.

## Consequences

- A body concept can now surface a missing Related Sections suggestion even when
  there is no explicit section-number citation for the existing A2/A3 reference
  checks to inspect.
- The implementation is deterministic, testable without a database, and cheap to
  recompute with the rest of the coordination report.
- The rule intentionally favors precision over recall. A title whose only useful
  words are generic, too short, or common across the scoped catalog will not
  produce a suggestion.
- The finding is advisory. It should guide reviewer attention, not block
  generation or mark the spec invalid.
