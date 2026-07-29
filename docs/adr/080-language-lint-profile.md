# ADR-080: language lint profile — mechanism and boundary

## Status

Accepted

## Context

Issue #411: SpecR has zero prose-linting substrate. Firms have real, standing language
conventions — "furnish and install" over ambiguous "if required" phrasing, "Owner"
and "Contractor" as the only recognized parties (never "subcontractor" or
"electrical contractor"), the firm's own name for the architect/engineer of record
("A/E", "Megacorp", "Bob's Consulting"), avoidance of reinforcing words ("all",
"any", "every", "strict", "very") that create ambiguity a contractor can exploit
("well, you said *any* of these, not *all* of these"). None of this is checked
today; no issue, PR, or ADR touches it.

The tension is deliberate and already on the record: ADR-019 stakes SpecR out as a
**content-neutral platform** — it is never a content provider, and a firm's list of
banned words or approved party names is exactly the kind of content judgment
ADR-019 puts outside the platform's opinions. That is why this ADR exists — to fix
the boundary in writing before any code lands, not to bless a house style.

A pre-implementation spike built the matching engine and the schema against real
inputs before this design was finalized. It confirmed the shape below and surfaced
two corrections, both binding and recorded in the Decision section: a matching-
boundary bug that would have silently broken on the issue's own headline example,
and a schema-authoring requirement the existing convention-profile schema does not
need.

## Decision

### D1 — Mechanism, not opinion (ADR-019 boundary)

SpecR ships the **rule engine and the schema**; it ships **zero rule content**. A
library with no language-rule profile lints nothing — there is no built-in default
list of banned words, required parties, or reinforcing terms, unlike ADR-022's
convention profiles (which *do* seed a built-in default because structural
detection, unlike word choice, is not a content opinion). Every category
(`bannedTerms`, `reinforcingWords`, `partyVocabulary`, `requiredPhrases`) starts
empty until a firm authors it. This is the whole of what makes language linting
compatible with ADR-019: the platform never has a house style to disagree with.

### D2 — Two-column scope table, not three

Language-rule profiles are scoped by `(library_id, project_id)` with the same
XOR-owner shape as `division_general_specs` (migration 022): exactly one of the two
is set, enforced by a CHECK constraint, one unique partial index per column. A
project-level profile is deliberately possible (a single project's owner wants
stricter language than the firm master) even though the common case is
library-level. There is no separate `client_id` column — see D3 for how the client
tier participates without one.

### D3 — Company (client) resolution is a single conditional hop, never a walk

A project optionally belongs to a client (`projects.client_id → clients.id`,
migration 040), and a client optionally owns a library
(`clients.library_id → libraries.id`). Resolving a project's language rules
therefore *may* pick up one additional layer — the client's library profile — via
exactly one conditional join: `projects.client_id → clients.library_id →
language_rule_profiles.library_id`. This is not a recursive hierarchy walk and
cannot become one: `clients.library_id` points at a library, never at another
client, so the join terminates after one hop by construction, not by a depth guard.
Firm tier (a level above client) does not exist yet (tracked separately); when it
arrives, it extends this chain by one more conditional join of the same shape, not
a different resolution algorithm.

### D4 — Project-copy specs resolve through their originating library, not just their own project

A spec created by copying a master into a project (`specs.parent_spec_id` points at
the master row) must still see the *master's* library-level language rules, not
only the project's own profile — the firm's banned-word list should not silently
stop applying just because the paragraph now lives in a project-owned copy.
`resolveAuthoringLibraryId` computes this with
`COALESCE(s.library_id, master.library_id)` via
`LEFT JOIN specs master ON master.id = s.parent_spec_id`, spike-verified against
both a spec that is itself library-owned and a spec that is a project copy of a
library master. This mirrors the existing `parent_spec_id` chain-of-custody use
(ADR-015) — no new provenance concept is introduced.

### D5 — Resolution stack and merge are additive, not override

`resolveLanguageRulesForSpec` assembles the applicable layers broadest-to-narrowest
— resolved authoring library, then (if the spec's project has a client with a
library) the client library, then the project's own profile — and
`mergeLanguageRules` concatenates each of the four categories across layers,
de-duplicating on `` `${isRegex ? term : term.toLowerCase()}::${isRegex ?? false}` ``
— literal terms are case-folded because they match case-insensitively, regex
sources are **not**, because the `i` flag does not make character-class escapes
equivalent (`\s` and `\S`, `\d`/`\D`, `\b`/`\B`, `\w`/`\W` are opposite rules,
and folding the source would collapse two of them onto one key) — with the
narrowest (last) layer winning a collision. This is additive-with-override-on-
conflict, not last-layer-replaces-all: a project profile that adds one banned term
does not silently drop the firm's whole list, which is the failure mode a naive
"project profile takes precedence" design would produce. Zero layers found
anywhere is not an error — it resolves to `{ layers: [], rules: {} }`, meaning
linting is off for that spec, consistent with D1's opt-in stance.
`resolveLanguageRulesForSpec` never throws; a spec that cannot be resolved at all
degrades to no linting, not a failure.

### D6 — Matching: lookaround boundaries, not `\b` (spike correction, supersedes the pre-spike design)

Literal terms (`isRegex` false or absent) are matched with
`` new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi') ``, never
`` new RegExp(`\\b${escaped}\\b`, 'gi') ``. This is the one place in this feature a
naive implementer will reach for `\b` and silently ship a regression, so it is
called out here explicitly, not left to a code comment alone.

`\b` only fires at a transition between a word character and a non-word character.
A term whose own edge character is already non-word — "A.E.", "A/E", "Owner's
Rep." — is exactly the issue's own party-vocabulary example, and for such a term
`\b` never produces the required transition at that edge, so the rule silently
never matches. There is no exception thrown, no warning logged; the firm's party
name simply never gets flagged, and nothing in the system says so. Lookaround does
not have this failure mode because it asserts only against the character
*outside* the match, independent of what the term's own edge character is. Spike-
verified: `(?<![A-Za-z0-9_])install(?![A-Za-z0-9_])` correctly excludes "installer"
but matches standalone "install"; `(?<![A-Za-z0-9_])any(?![A-Za-z0-9_])` excludes
"anyway" but matches standalone "any"; `(?<![A-Za-z0-9_])A\.E\.(?![A-Za-z0-9_])`
matches "A.E." and correctly does not match inside "AXE"; `(?<![A-Za-z0-9_])A/E(?!
[A-Za-z0-9_])` matches "A/E" cleanly. `\b` fails the "A.E." and "A/E" cases outright
because both terms' own edges are already non-word characters.

`isRegex: true` terms are passed through `checkRegexPatterns` (existing ReDoS/
length/count guard, `src/lib/regex-safety.ts`) and then used exactly as authored —
no automatic boundary wrapping. A regex author owns their own boundaries; auto-
wrapping a user-supplied pattern would silently change its meaning.

### D7 — Two finding shapes, not four; category is data

Findings use the same discriminated-union-with-`readonly`-fields convention as
`src/db/queries/coordination.ts`'s `Finding` type: `language_term_flagged` (used
for all three per-term categories — `bannedTerm` / `reinforcingWord` /
`partyVocabulary` — with `category` carried as a data field, not a fourth type
tag) and `language_phrase_missing` (for `requiredPhrases`, which is a
whole-spec-presence check, not a per-paragraph match — see D8). Three
categories sharing one shape and differing only in a `category` string is the
same DRY judgment already applied elsewhere in this codebase to per-signal or
per-source variation: the categories are genuinely the same operation
(scan text, report a match) with a label, not three different operations.

### D8 — `requiredPhrases` is whole-spec presence, not per-paragraph absence

A missing required phrase ("furnish and install" somewhere in the section) cannot
be pinned to one paragraph — it is a fact about the whole spec's concatenated
scanned text. `scanSpecForMissingPhrases` therefore runs once per spec over
`allScannedText` (the concatenation of every non-vanished, non-note paragraph),
not once per paragraph. Paragraph-scoped categories (`bannedTerm`,
`reinforcingWord`, `partyVocabulary`) and the whole-spec category
(`requiredPhrases`) are deliberately different functions
(`scanParagraphForCategory` vs. `scanSpecForMissingPhrases`) rather than one
function parameterized by scope — forcing one signature to cover both shapes was
exactly the kind of knot `code.md`'s DRY guidance warns against.

### D9 — Scanning excludes vanished content and notes

`loadScannableParagraphs` filters `vanish = false AND node_type <> 'note'`.
Suppressed content was never meant to reach the owner and should not be linted as
if it will; editorial notes (`[NOTE]`) are instructions to the spec writer, not
contract language, and linting them against the firm's contract-language rules
would be a category error.

### D10 — No default rule content, no clone endpoint, no resolve-preview endpoint

Consistent with D1: v1 ships `GET`/`PUT`/`DELETE` on `/libraries/:id/language-rules`
and `/projects/:id/language-rules`, plus one read-only report endpoint
(`GET /projects/:id/language-findings`). There is no endpoint to clone a profile
between scopes and no endpoint to preview the merged/resolved rule set ahead of
running a report — both are legitimate future UX conveniences, not part of the
mechanism this ADR is scoping. The `PUT` body carries only `{ rules }`; there is no
`name` field, unlike `editing_conventions` (which names a convention because
multiple named conventions can exist per library) — a language-rule profile is a
singleton per scope, so nothing needs naming.

## Non-goals (v1, explicit)

- **Imperative-mood detection.** Real grammar analysis ("Contractor shall provide"
  vs. "Provide") is out of scope for this deterministic, regex/word-list engine.
  An LLM reading a spec's rendered markdown can already do this ad hoc today; if
  it is ever built into the platform, that is a separate LLM-assisted feature,
  not an extension of this mechanism.
- **Auto-rewrite.** This feature flags; it never edits spec text on a firm's
  behalf.
- **Any shipped default rule content.** No built-in banned-word list, no seeded
  party vocabulary, not even an "example" profile with real terms in it — see D1.
  An empty schema is the entire product surface the platform owns.
- **Clone-between-scopes and resolve-preview endpoints.** See D10.
- **A firm tier above client.** See D3 — the resolution chain is designed to
  extend by one more conditional hop when that tier exists, but it does not exist
  today and this ADR does not add it.

## Consequences

**Positive**

- The platform gains a real prose-linting capability while keeping ADR-019's
  content-neutral stance intact — the schema and engine are generic; every rule a
  firm sees came from that firm.
- The matching engine actually catches the issue's own motivating example
  ("A/E", "A.E.") — the pre-spike `\b` design would have shipped this feature in
  a state where it silently failed on exactly the case it was written for.
- The resolution chain (library → client library → project) reuses existing
  schema (`clients.library_id`, `specs.parent_spec_id`) with no new provenance
  concept, and stays correct if a firm tier is added later without changing its
  shape.

**Negative / trade-offs**

- `checkRegexPatterns`' `MAX_REGEX_PATTERNS` (64) and `MAX_REGEX_PATTERN_LENGTH`
  (200) bounds apply only to `isRegex: true` terms. Literal terms — the majority
  of a real firm's list — have no count or length bound. This is not a security
  gap (literal terms are always escaped before use, never interpreted as regex
  syntax), but it is a conscious v1 choice given `scanParagraphForCategory`'s
  O(terms × paragraphs) scan cost: a firm with an unusually large literal-term
  list pays that cost with no platform-side guard today. A future bound (mirroring
  the regex-term limits) is a reasonable follow-up if real firm lists prove large
  enough to matter; it is not needed to ship v1.
- Two additional scope-resolution layers (client, project) beyond the library
  mean a findings report can be affected by a profile the requester did not
  directly edit — expected and desired (D5), but worth remembering when
  debugging "why did this term get flagged" reports: the answer may live in a
  parent scope.
- `requiredPhrases`' whole-spec-presence check (D8) cannot report *where* the
  gap is beyond "somewhere in this spec" — there is no such location to report
  for an absence. This is a schema-level limitation, not an implementation bug.

## Related

- ADR-019 (content-neutral platform — the constraint this ADR is designed to
  satisfy)
- ADR-015 (library tiers, `parent_spec_id` chain-of-custody — reused by D4)
- ADR-022 (convention profiles — nearest existing scoped-JSONB-profile precedent;
  this ADR deliberately does *not* copy its built-in-default behavior, see D1)
- migration 022 (`division_general_specs` — the two-column XOR scope precedent
  this feature's scope table mirrors, D2)
- migration 040 (`clients` — the single conditional hop this feature's company
  resolution relies on, D3)
- `src/lib/regex-safety.ts` (`checkRegexPatterns`, ReDoS/length/count guard reused
  unchanged for `isRegex: true` terms)
- `src/db/queries/coordination.ts` (`Finding` discriminated-union convention this
  feature's findings shape follows, D7)
